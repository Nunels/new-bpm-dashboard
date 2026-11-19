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
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final Map<String, GenerationJob> jobs = new LinkedHashMap<>(16, 0.75f, false) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, GenerationJob> eldest) {
            return size() > MAX_JOBS;
        }
    };

    public GenerationService(OfferModel model, DashboardJs js, DslChecks dsl, @ConfigProperty(name = "agent.max-attempts") int maxAttempts) {
        this.model = model;
        this.js = js;
        this.dsl = dsl;
        this.maxAttempts = Math.max(1, maxAttempts);
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

    void run(GenerationJob job, String spec, JsonNode catalog) {
        JsonNode steps = js.steps();
        OfferSchema schema = OfferSchema.forCatalog(catalog, steps);
        String previous = null;
        List<String> errors = List.of();
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
                job.errors = a.errors;
                job.finish(Status.ERROR);
                LOG.infof("generazione %s: modello non disponibile (%s)", job.id, e.getMessage());
                return;
            }
            job.progress = "Tentativo " + n + " di " + maxAttempts + ": validazione";
            Outcome o = evaluate(response, schema, catalog);
            a.errors = o.errors;
            a.millis = System.currentTimeMillis() - t0;
            job.attempts.add(a);
            LOG.infof("generazione %s: tentativo %d, %d errori, %d avvisi", job.id, n, o.errors.size(), o.warnings.size());
            if (o.errors.isEmpty()) {
                job.offer = o.offer;
                job.modelOutput = parsed(response);
                job.files = o.files;
                job.warnings = o.warnings;
                job.simulation = o.simulation;
                job.finish(o.warnings.isEmpty() ? Status.SUCCESS : Status.WARNING);
                return;
            }
            previous = response;
            errors = o.errors;
        }
        job.errors = errors;
        job.finish(Status.ERROR);
    }

    /** Chiamata al modello con un nuovo tentativo sugli errori transitori (429, 5xx, rete). */
    private String call(String prompt, OfferSchema schema) throws ModelException {
        try {
            return model.generate(prompt, schema.forModel());
        } catch (ModelException e) {
            if (!e.retryable()) throw e;
            try {
                Thread.sleep(2000);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw e;
            }
            return model.generate(prompt, schema.forModel());
        }
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
        return new Outcome(errors, warnings, a.get("offer"), files, sim);
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
