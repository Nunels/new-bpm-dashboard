package it.sim.agent;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;
import org.jboss.logging.MDC;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import it.sim.agent.GenerationJob.Attempt;
import it.sim.agent.GenerationJob.DslFile;
import it.sim.agent.GenerationJob.Status;
import it.sim.agent.OfferModel.ModelException;

/**
 * Agente: specifica → modello (output strutturato) → validazione → correzione con gli errori (max N tentativi).
 * Esito: SUCCESS (nessun avviso), WARNING (avvisi di validazione, assunzioni del modello, simulazione non completa),
 * ERROR (errori residui dopo l'ultimo tentativo o modello non disponibile). Il contenuto della specifica non viene loggato.
 */
@ApplicationScoped
public class GenerationService {

    private static final Logger LOG = Logger.getLogger(GenerationService.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_JOBS = 200;

    private final OfferModel model;
    private final DashboardJs js;
    private final DslChecks dsl;
    private final int maxAttempts;
    private final boolean coverageCheck;
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final Map<String, GenerationJob> jobs = new LinkedHashMap<>(16, 0.75f, false) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, GenerationJob> eldest) {
            return size() > MAX_JOBS;
        }
    };

    public GenerationService(OfferModel model, DashboardJs js, DslChecks dsl, @ConfigProperty(name = "agent.max-attempts") int maxAttempts,
            @ConfigProperty(name = "agent.coverage-check", defaultValue = "true") boolean coverageCheck) {
        this.model = model;
        this.js = js;
        this.dsl = dsl;
        this.maxAttempts = Math.max(1, maxAttempts);
        this.coverageCheck = coverageCheck;
    }

    public OfferModel model() {
        return model;
    }

    public int maxAttempts() {
        return maxAttempts;
    }

    public synchronized Optional<GenerationJob> find(String id) {
        return Optional.ofNullable(jobs.get(id));
    }

    public GenerationJob start(String fileName, String spec, JsonNode catalog) {
        GenerationJob job = new GenerationJob(fileName, model.name());
        synchronized (this) {
            jobs.put(job.id, job);
        }
        executor.submit(() -> {
            MDC.put("job", job.id);
            try {
                run(job, spec, catalog);
            } catch (RuntimeException e) {
                LOG.errorf(e, "generazione %s interrotta da un errore interno", job.id);
                job.errors = List.of("Errore interno durante la generazione: " + e.getMessage());
                job.finish(Status.ERROR);
            } finally {
                MDC.remove("job");
            }
        });
        return job;
    }

    /** Avvisi di validazione che il modello può correggere da solo (es. input obbligatorio senza valore): provocano una correzione. */
    static final String FIXABLE = "input obbligatorio";

    void run(GenerationJob job, String spec, JsonNode catalog) {
        JsonNode steps = js.steps();
        OfferSchema schema = OfferSchema.forCatalog(catalog, steps);
        String previous = null;
        List<String> errors = List.of();
        Outcome fallback = null;           // ultima risposta valida con avvisi correggibili: se le correzioni peggiorano, si usa questa
        String fallbackResponse = null;
        for (int n = 1; n <= maxAttempts; n++) {
            Attempt a = new Attempt();
            a.n = n;
            a.kind = previous == null ? "GENERATION" : "REPAIR";
            long t0 = System.currentTimeMillis();
            job.progress = "Tentativo " + n + " di " + maxAttempts + ": " + (previous == null ? "generazione" : "correzione degli errori");
            String prompt = previous == null ? PromptBuilder.generation(catalog, steps, job.fileName, spec)
                    : PromptBuilder.repair(catalog, steps, job.fileName, spec, previous, errors);
            String response;
            try {
                response = call(prompt, schema);
            } catch (ModelException e) {
                a.errors = List.of("Modello non disponibile: " + e.getMessage());
                a.millis = System.currentTimeMillis() - t0;
                job.attempts.add(a);
                LOG.infof("generazione %s: modello non disponibile (%s)", job.id, e.getMessage());
                if (fallback != null) {
                    accept(job, fallback, fallbackResponse);
                    return;
                }
                job.errors = a.errors;
                job.finish(Status.ERROR);
                return;
            }
            job.progress = "Tentativo " + n + " di " + maxAttempts + ": validazione";
            Outcome o = evaluate(response, schema, catalog);
            boolean rejected = false;
            if (o.errors.isEmpty() && fallbackResponse != null && previous == fallbackResponse) {
                // una correzione deve restituire la configurazione COMPLETA: se perde elementi della risposta valida precedente, è un errore
                List<String> lost = lostElements(fallbackResponse, response);
                if (!lost.isEmpty()) {
                    rejected = true;
                    LOG.warnf("generazione %s: la correzione ha eliminato elementi esistenti (%s), scartata", job.id, lost);
                    o = new Outcome(List.of("La correzione ha eliminato elementi della configurazione precedente (" + String.join("; ", lost)
                            + "). Restituisci la configurazione COMPLETA, con tutti i blocchi e tutte le barre, modificando solo ciò che è indicato."),
                            List.of(), null, List.of(), Map.of());
                }
            }
            a.errors = o.errors;
            a.millis = System.currentTimeMillis() - t0;
            job.attempts.add(a);
            LOG.infof("generazione %s: tentativo %d, %d errori, %d avvisi", job.id, n, o.errors.size(), o.warnings.size());
            if (o.errors.isEmpty()) {
                List<Gap> gaps = List.of();
                if (coverageCheck) {
                    job.progress = "Tentativo " + n + " di " + maxAttempts + ": controllo di copertura della specifica";
                    gaps = coverageGaps(response, job.fileName, spec, catalog, schema);
                    LOG.infof("generazione %s: controllo di copertura, %d differenze", job.id, gaps.size());
                }
                if (!gaps.isEmpty()) {
                    // le differenze sulla config di un blocco (koTask, retry, template...) si applicano direttamente
                    Patched p = applyPatches(response, gaps);
                    if (p != null) {
                        Outcome patched = evaluate(p.response(), schema, catalog);
                        if (patched.errors().isEmpty()) {
                            LOG.infof("generazione %s: %d correzioni applicate dal controllo di copertura: %s", job.id, p.applied().size(), p.applied());
                            List<String> all = new ArrayList<>(job.appliedFixes);
                            all.addAll(p.applied());
                            job.appliedFixes = List.copyOf(all);
                            response = p.response();
                            o = patched;
                            gaps = p.remaining();
                        } else {
                            LOG.warnf("generazione %s: correzioni automatiche scartate, la configurazione non sarebbe valida: %s", job.id, patched.errors());
                        }
                    }
                }
                List<String> fixable = o.warnings.stream().filter(w -> w.contains(FIXABLE)).toList();
                List<String> toFix = new ArrayList<>();
                fixable.forEach(w -> toFix.add(instruction(w)));
                gaps.forEach(g -> toFix.add("Copertura della specifica: " + g.text()));
                if (toFix.isEmpty()) {
                    accept(job, o, response);
                    return;
                }
                Outcome withGaps = withWarnings(o, gaps.stream().map(g -> "Controllo di copertura: " + g.text()).toList());
                if (n == maxAttempts) {
                    accept(job, withGaps, response);   // nessun tentativo rimasto: le differenze restano come avvisi
                    return;
                }
                LOG.infof("generazione %s: %d punti da correggere, richiesta di correzione", job.id, toFix.size());
                a.errors = toFix;
                fallback = withGaps;
                fallbackResponse = response;
                previous = response;
                errors = toFix;
                continue;
            }
            previous = rejected ? fallbackResponse : response;   // dopo uno scarto si riparte dall'ultima risposta valida
            errors = o.errors;
        }
        if (fallback != null) {
            accept(job, fallback, fallbackResponse);
            return;
        }
        job.errors = errors;
        job.finish(Status.ERROR);
    }

    private void accept(GenerationJob job, Outcome o, String response) {
        job.offer = o.offer;
        job.modelOutput = parsed(response);
        job.files = o.files;
        job.warnings = o.warnings;
        job.simulation = o.simulation;
        job.finish(o.warnings.isEmpty() ? Status.SUCCESS : Status.WARNING);
    }

    /** Chiamata al modello con un nuovo tentativo sugli errori transitori (429, 5xx, rete). */
    private String call(String prompt, OfferSchema schema) throws ModelException {
        return call(prompt, schema.forModel());
    }

    private String call(String prompt, JsonNode responseSchema) throws ModelException {
        try {
            return model.generate(prompt, responseSchema);
        } catch (ModelException e) {
            if (!e.retryable()) throw e;
            try {
                Thread.sleep(2000);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw e;
            }
            return model.generate(prompt, responseSchema);
        }
    }

    /** Prodotti, blocchi e barre presenti nella risposta precedente e assenti in quella nuova (vuoto = nessuna perdita). */
    static List<String> lostElements(String before, String after) {
        try {
            JsonNode b = JSON.readTree(stripFences(before)).path("offer"), a = JSON.readTree(stripFences(after)).path("offer");
            List<String> out = new ArrayList<>();
            addMissing(out, "prodotti", b.path("products"), a.path("products"), null);
            addMissing(out, "blocchi", b.path("blocks"), a.path("blocks"), "id");
            addMissing(out, "barre", b.path("gates"), a.path("gates"), "id");
            return out;
        } catch (IOException e) {
            return List.of();
        }
    }

    private static void addMissing(List<String> out, String label, JsonNode before, JsonNode after, String idField) {
        Set<String> now = new HashSet<>();
        after.forEach(x -> now.add(idField == null ? x.asText() : x.path(idField).asText()));
        List<String> missing = new ArrayList<>();
        before.forEach(x -> {
            String id = idField == null ? x.asText() : x.path(idField).asText();
            if (!now.contains(id)) missing.add(id);
        });
        if (!missing.isEmpty()) out.add(label + " mancanti: " + String.join(", ", missing));
    }

    /** Differenza trovata dal controllo di copertura; patch = correzione della config del blocco (se applicabile). */
    record Gap(String blockId, String issue, JsonNode patch) {
        String text() {
            return (blockId == null || blockId.isBlank() ? "" : blockId + ": ") + issue;
        }
    }

    record Patched(String response, List<Gap> remaining, List<String> applied) {
    }

    /**
     * Controllo di copertura: seconda lettura della specifica contro la configurazione prodotta, per scovare requisiti
     * omessi (task manuali su KO, SLA, retry, template...). Se la chiamata fallisce non blocca la generazione.
     */
    List<Gap> coverageGaps(String response, String fileName, String spec, JsonNode catalog, OfferSchema schema) {
        try {
            String text = call(PromptBuilder.audit(catalog, fileName, spec, stripFences(response)), PromptBuilder.coverageSchema(schema.configSchemaForModel()));
            List<Gap> out = new ArrayList<>();
            JSON.readTree(stripFences(text)).path("gaps").forEach(g -> {
                if (out.size() >= 20) return;
                Gap gap = g.isTextual() ? new Gap("", g.asText().trim(), null)
                        : new Gap(g.path("blockId").asText("").trim(), g.path("issue").asText("").trim(), g.has("configPatch") ? g.get("configPatch") : null);
                if (!gap.issue().isEmpty() && !out.contains(gap)) out.add(gap);
            });
            return out;
        } catch (ModelException | IOException e) {
            LOG.warnf("controllo di copertura non riuscito: %s", e.getMessage());
            return List.of();
        }
    }

    /** Applica alla config dei blocchi le correzioni proposte dal controllo di copertura; null se non c'è nulla da applicare. */
    static Patched applyPatches(String response, List<Gap> gaps) {
        try {
            JsonNode root = JSON.readTree(stripFences(response));
            JsonNode blocks = root.path("offer").path("blocks");
            List<Gap> remaining = new ArrayList<>();
            List<String> applied = new ArrayList<>();
            for (Gap g : gaps) {
                ObjectNode block = null;
                for (JsonNode b : blocks) if (b.path("id").asText().equals(g.blockId())) block = (ObjectNode) b;
                if (block == null || g.patch() == null || !g.patch().isObject() || g.patch().isEmpty()) {
                    remaining.add(g);
                    continue;
                }
                ObjectNode cfg = block.path("config").isObject() ? (ObjectNode) block.get("config") : block.putObject("config");
                merge(cfg, g.patch());
                applied.add(g.text());
            }
            return applied.isEmpty() ? null : new Patched(root.toString(), remaining, applied);
        } catch (IOException | ClassCastException e) {
            return null;
        }
    }

    private static void merge(ObjectNode target, JsonNode patch) {
        patch.fields().forEachRemaining(e -> {
            if (e.getValue().isObject() && target.path(e.getKey()).isObject()) merge((ObjectNode) target.get(e.getKey()), e.getValue());
            else target.set(e.getKey(), e.getValue().deepCopy());
        });
    }

    /** Trasforma l'avviso «[B_X]: input obbligatorio "template" senza sorgente/valore» in un'istruzione precisa per il modello. */
    static String instruction(String warning) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\[(B_[A-Z0-9_]+)\\]: input obbligatorio \"([^\"]+)\"").matcher(warning);
        if (!m.find()) return warning;
        return "Blocco " + m.group(1) + ": manca config.inputMapping." + m.group(2) + " (input obbligatorio senza valore). "
                + "Impostalo con il valore indicato nella specifica per questo blocco, per esempio {\"" + m.group(2) + "\": \"<valore>\"}.";
    }

    private static Outcome withWarnings(Outcome o, List<String> extra) {
        if (extra.isEmpty()) return o;
        List<String> warnings = new ArrayList<>(o.warnings);
        extra.forEach(w -> { if (!warnings.contains(w)) warnings.add(w); });
        return new Outcome(o.errors, warnings, o.offer, o.files, o.simulation);
    }

    record Outcome(List<String> errors, List<String> warnings, JsonNode offer, List<DslFile> files, Map<String, String> simulation) {
    }

    /** Valida una risposta del modello. Pubblico nel package per i test e per la valutazione. */
    Outcome evaluate(String response, OfferSchema schema, JsonNode catalog) {
        JsonNode r;
        try {
            r = JSON.readTree(stripFences(response));
        } catch (IOException e) {
            String msg = e instanceof com.fasterxml.jackson.core.JsonProcessingException jpe ? jpe.getOriginalMessage() : e.getMessage();
            return fail("La risposta non è JSON valido: " + msg);
        }
        List<String> schemaErrors = schema.validate(r);
        if (!schemaErrors.isEmpty()) return new Outcome(prefix("Schema della risposta: ", schemaErrors), List.of(), null, List.of(), Map.of());
        List<String> errors = new ArrayList<>(duplicates(r.get("offer")));
        if (!errors.isEmpty()) return new Outcome(errors, List.of(), null, List.of(), Map.of());

        JsonNode a = js.analyze(catalog, r.get("offer"));
        a.at("/validation/errors").forEach(e -> errors.add("Validazione: " + e.asText()));
        if (!errors.isEmpty()) return new Outcome(errors, List.of(), null, List.of(), Map.of());

        List<DslFile> files = new ArrayList<>();
        a.get("files").forEach(f -> files.add(new DslFile(f.get("name").asText(), f.get("content").asText())));
        files.forEach(f -> dsl.check(f.name, f.content).forEach(p -> errors.add("DSL generato: " + p)));
        if (!a.at("/roundTrip/ok").asBoolean()) a.at("/roundTrip/errors").forEach(e -> errors.add("DSL non riconvertibile in dashboard: " + e.asText()));

        List<String> warnings = new ArrayList<>();
        a.at("/validation/warnings").forEach(w -> warnings.add("Validazione: " + w.asText()));
        r.path("assumptions").forEach(x -> warnings.add("Assunzione dell'agente: " + x.asText()));
        Map<String, String> sim = new LinkedHashMap<>();
        sim.put("status", a.at("/simulation/status").asText());
        sim.put("message", a.at("/simulation/message").asText());
        if (!"COMPLETED".equals(sim.get("status"))) warnings.add("Simulazione con tutti gli esiti OK: " + sim.get("status") + " (" + sim.get("message") + ")");
        return new Outcome(errors, new ArrayList<>(new java.util.LinkedHashSet<>(warnings)), a.get("offer"), files, sim);
    }

    /** JSON del modello così come è stato validato (senza eventuali recinti di codice). */
    private static JsonNode parsed(String response) {
        try {
            return JSON.readTree(stripFences(response));
        } catch (IOException e) {
            return null;
        }
    }

    private static Outcome fail(String error) {
        return new Outcome(List.of(error), List.of(), null, List.of(), Map.of());
    }

    private static List<String> prefix(String p, List<String> items) {
        List<String> out = new ArrayList<>();
        items.forEach(i -> out.add(p + i));
        return out;
    }

    /** Id duplicati di blocchi e barre: la validazione della dashboard li presuppone univoci. */
    private static List<String> duplicates(JsonNode offer) {
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        offer.path("blocks").forEach(b -> { if (!seen.add("B:" + b.path("id").asText())) out.add("Id di blocco duplicato: " + b.path("id").asText()); });
        offer.path("gates").forEach(g -> { if (!seen.add("G:" + g.path("id").asText())) out.add("Id di barra duplicato: " + g.path("id").asText()); });
        return out;
    }

    /** Alcuni modelli racchiudono il JSON tra ```json e ```: li tolgo. */
    static String stripFences(String s) {
        String t = s.trim();
        if (t.startsWith("```")) {
            int nl = t.indexOf('\n');
            int end = t.lastIndexOf("```");
            if (nl > 0 && end > nl) return t.substring(nl + 1, end).trim();
        }
        return t;
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }
}
