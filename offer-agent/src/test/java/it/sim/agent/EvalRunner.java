package it.sim.agent;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Valutazione con il modello REALE sul set di specifiche di src/test/resources/specs (da lanciare a mano, solo dopo
 * l'autorizzazione all'uso del servizio). Per ogni specifica confronta l'offerta generata con quella attesa su
 * prodotti, blocchi (task + prodotti), dipendenze e regole dei gate.
 *
 * <pre>
 * $env:GEMINI_API_KEY="..."; $env:GEMINI_MODEL="gemini-4-hydrogen"
 * mvn -q test-compile exec:java "-Dexec.mainClass=it.sim.agent.EvalRunner" "-Dexec.classpathScope=test"
 * </pre>
 */
public final class EvalRunner {

    static final List<String> SPECS = List.of("conto-mono.md", "famiglia.md", "conto-tim-ambigua.md", "casa-fuori-catalogo.md");
    private static final ObjectMapper JSON = new ObjectMapper();

    private EvalRunner() {
    }

    public static void main(String[] args) throws Exception {
        String key = System.getenv("GEMINI_API_KEY");
        if (key == null || key.isBlank()) {
            System.out.println("Imposta GEMINI_API_KEY (e facoltativamente GEMINI_MODEL, GEMINI_BASE_URL).");
            return;
        }
        String model = env("GEMINI_MODEL", "gemini-4-hydrogen");
        GeminiOfferModel gemini = new GeminiOfferModel(key, model, env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com"),
                "2026-05-20", Duration.ofSeconds(180));
        DashboardJs js = new DashboardJs();
        GenerationService service = new GenerationService(gemini, js, new DslChecks(), 3, true);
        JsonNode seed = js.seed();
        ObjectNode catalog = JSON.createObjectNode();
        catalog.set("products", seed.get("products"));
        catalog.set("tasks", seed.get("tasks"));

        System.out.printf("Modello %s%n%-24s %-8s %4s  %-9s %-9s %-9s %-9s%n", model, "specifica", "esito", "tent.", "prodotti", "blocchi", "dipend.", "gate");
        double total = 0;
        for (String spec : SPECS) {
            GenerationJob job = new GenerationJob(spec, model);
            service.run(job, read("/specs/" + spec), catalog);
            JsonNode expected = JSON.readTree(read("/specs/" + spec.replace(".md", ".expected.json"))).get("offer");
            if (job.offer == null) {
                System.out.printf("%-24s %-8s %4d  %s%n", spec, job.status, job.attempts.size(), String.join(" | ", job.errors));
                continue;
            }
            double p = jaccard(products(expected), products(job.offer));
            double b = jaccard(blocks(expected), blocks(job.offer));
            double d = jaccard(deps(expected), deps(job.offer));
            double g = jaccard(gates(expected), gates(job.offer));
            total += (p + b + d + g) / 4;
            System.out.printf("%-24s %-8s %4d  %-9.2f %-9.2f %-9.2f %-9.2f%n", spec, job.status, job.attempts.size(), p, b, d, g);
            if (b < 1) System.out.println("    blocchi attesi " + blocks(expected) + "\n    blocchi ottenuti " + blocks(job.offer));
            if (g < 1) System.out.println("    gate attesi " + gates(expected) + "\n    gate ottenuti " + gates(job.offer));
            job.warnings.forEach(w -> System.out.println("    avviso: " + w));
        }
        System.out.printf("Punteggio medio: %.2f (1 = identico all'atteso)%n", total / SPECS.size());
        js.close();
        System.exit(0);
    }

    static Set<String> products(JsonNode o) {
        Set<String> s = new TreeSet<>();
        o.path("products").forEach(p -> s.add(p.asText()));
        return s;
    }

    /** Blocco identificato da task e prodotti (gli id scelti dal modello non contano). */
    static Set<String> blocks(JsonNode o) {
        Set<String> s = new TreeSet<>();
        o.path("blocks").forEach(b -> s.add(b.path("taskId").asText() + ":" + sorted(b.path("products"))));
        return s;
    }

    static Set<String> deps(JsonNode o) {
        Set<String> s = new TreeSet<>();
        o.path("blocks").forEach(b -> b.path("dependsOn").forEach(d -> s.add(nodeOf(o, d.asText(), 0) + "->" + b.path("taskId").asText())));
        o.path("gates").forEach(g -> g.path("dependsOn").forEach(d -> s.add(nodeOf(o, d.asText(), 0) + "->" + nodeOf(o, g.path("id").asText(), 0))));
        return s;
    }

    static Set<String> gates(JsonNode o) {
        Set<String> s = new TreeSet<>();
        o.path("gates").forEach(g -> g.path("rules").forEach(r -> s.add(nodeOf(o, g.path("id").asText(), 0) + ":" + r.path("type").asText()
                + (r.has("blockId") ? ":" + nodeOf(o, r.get("blockId").asText(), 0) : "") + (r.has("products") ? ":" + sorted(r.get("products")) : ""))));
        return s;
    }

    /** Nodo senza id: un blocco è il suo task, un gate è identificato dai nodi da cui dipende. */
    private static String nodeOf(JsonNode o, String id, int depth) {
        for (JsonNode b : o.path("blocks")) if (b.path("id").asText().equals(id)) return b.path("taskId").asText();
        for (JsonNode g : o.path("gates")) {
            if (!g.path("id").asText().equals(id)) continue;
            Set<String> parents = new TreeSet<>();
            if (depth < 20) g.path("dependsOn").forEach(d -> parents.add(nodeOf(o, d.asText(), depth + 1)));
            return "gate(" + String.join(",", parents) + ")";
        }
        return id + "?";
    }

    private static String sorted(JsonNode arr) {
        Set<String> s = new TreeSet<>();
        arr.forEach(x -> s.add(x.asText()));
        return String.join(",", s);
    }

    static double jaccard(Set<String> a, Set<String> b) {
        if (a.isEmpty() && b.isEmpty()) return 1;
        Set<String> inter = new TreeSet<>(a);
        inter.retainAll(b);
        Set<String> union = new TreeSet<>(a);
        union.addAll(b);
        return (double) inter.size() / union.size();
    }

    private static String read(String resource) throws Exception {
        try (InputStream in = EvalRunner.class.getResourceAsStream(resource)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isBlank() ? d : v;
    }
}
