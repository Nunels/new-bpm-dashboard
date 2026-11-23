package it.sim.agent;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import jakarta.inject.Inject;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import io.quarkus.test.common.QuarkusTestResource;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;

/** Flusso completo via API con il finto Gemini: esiti SUCCESS, WARNING ed ERROR e ciclo di correzione. */
@QuarkusTest
@QuarkusTestResource(FakeGemini.class)
class GenerationApiTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Inject
    DashboardJs js;

    private ObjectNode catalog() {
        JsonNode seed = js.seed();
        ObjectNode c = JSON.createObjectNode();
        c.set("products", seed.get("products"));
        c.set("tasks", seed.get("tasks"));
        return c;
    }

    private static String text(String name) {
        try (InputStream in = FakeGemini.spec(name)) {
            return in == null ? "# " + name + "\nspecifica di prova" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private JsonNode generate(String fileName) throws Exception {
        ObjectNode req = JSON.createObjectNode();
        req.put("fileName", fileName);
        req.put("specText", text(fileName));
        req.set("catalog", catalog());
        String id = given().contentType(ContentType.JSON).body(req.toString()).when().post("/api/generations")
                .then().statusCode(202).extract().path("id");
        long end = System.currentTimeMillis() + 60000;
        while (System.currentTimeMillis() < end) {
            JsonNode job = JSON.readTree(given().when().get("/api/generations/" + id).then().statusCode(200).extract().asString());
            if (!"RUNNING".equals(job.get("status").asText())) return job;
            Thread.sleep(100);
        }
        throw new AssertionError("generazione non terminata");
    }

    @Test
    void configReportsTheModel() {
        given().when().get("/api/config").then().statusCode(200)
                .body("model", org.hamcrest.Matchers.equalTo("gemini-fake")).body("configured", org.hamcrest.Matchers.equalTo(true));
    }

    @Test
    void explicitSpecIsASuccessWithDslAndRequestHasStructuredOutput() throws Exception {
        JsonNode job = generate("conto-mono.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(List.of(), list(job.get("warnings")));
        assertEquals("OFF_CONTO_ONLINE", job.at("/offer/id").asText());
        assertEquals("OFF_CONTO_ONLINE", job.at("/modelOutput/offer/id").asText(), "JSON del modello esposto per l'audit");
        assertTrue(job.at("/modelOutput/assumptions").isArray());
        assertEquals("BO_DOCUMENTI", job.at("/offer/blocks/0/config/koTask/queue").asText(), "config completata con i default del catalogo");
        assertEquals("offer-off-conto-online.sw.yaml", job.at("/files/0/name").asText());
        assertTrue(job.at("/files/0/content").asText().contains("generator: offer-process-designer"));
        assertEquals("COMPLETED", job.at("/simulation/status").asText());

        FakeGemini.Request r = FakeGemini.REQUESTS.stream().filter(x -> x.body().path("input").asText().contains("conto-mono.md")).findFirst().orElseThrow();
        assertEquals("test-key", r.headers().get("x-goog-api-key"));
        assertEquals("2026-05-20", r.headers().get("api-revision"));
        assertEquals("gemini-fake", r.body().get("model").asText());
        assertEquals("application/json", r.body().at("/response_format/mime_type").asText());
        JsonNode schema = r.body().at("/response_format/schema");
        assertEquals("[\"CONTO\",\"EVO\",\"LIBMIN\",\"TIM\"]", schema.at("/properties/offer/properties/products/items/enum").toString());
        JsonNode gateProps = schema.at("/properties/offer/properties/gates/items/properties");
        assertTrue(gateProps.has("dependsOn") && !gateProps.has("afterStep"), "i gate dipendono da nodi, non da uno step");
        assertFalse(schema.at("/properties/offer/properties/blocks/items/properties").has("stepId"));
        assertFalse(schema.toString().contains("\"pattern\""), "parole chiave non garantite rimosse");
        String prompt = r.body().get("input").asText();
        assertTrue(prompt.contains("<<<SPECIFICA") && prompt.contains("Controllo Cribis sul conto"));
        assertTrue(prompt.contains("\"compatibleProducts\""));
        assertFalse(PromptBuilder.RULES.toLowerCase().contains("step"), "le regole non parlano di step");
    }

    @Test
    void complexSpecWithAsyncKoTaskAndRetryIsASuccess() throws Exception {
        JsonNode job = generate("famiglia.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        String dsl = job.at("/files/0/content").asText();
        assertTrue(dsl.contains("type: bo.pratiche.esiti"));
        assertTrue(dsl.contains("queue: BO_RILAVORAZIONE"));
        assertTrue(dsl.contains("template: WELCOME_KIT"));
    }

    @Test
    void assumptionsBecomeWarnings() throws Exception {
        JsonNode job = generate("conto-tim-ambigua.md");
        assertEquals("WARNING", job.get("status").asText(), job.toString());
        assertEquals(3, job.get("warnings").size());
        assertTrue(job.get("warnings").get(0).asText().startsWith("Assunzione dell'agente: "));
        assertEquals(2, job.get("files").size(), "Oracolo 2 non atteso: sotto-workflow separato");
    }

    @Test
    void outOfCatalogRequestsAreReportedNotInvented() throws Exception {
        JsonNode job = generate("casa-fuori-catalogo.md");
        assertEquals("WARNING", job.get("status").asText(), job.toString());
        assertTrue(job.get("warnings").toString().contains("Mutuo"));
        assertEquals("[\"CONTO\"]", job.at("/offer/products").toString());
    }

    @Test
    void validationErrorsAreSentBackAndRepaired() throws Exception {
        JsonNode job = generate("riparabile.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(2, job.get("attempts").size());
        assertEquals("REPAIR", job.at("/attempts/1/kind").asText());
        assertTrue(job.at("/attempts/0/errors/0").asText().contains("Dipendenze circolari"), job.at("/attempts/0").toString());
        String repairPrompt = FakeGemini.REQUESTS.stream().map(x -> x.body().path("input").asText())
                .filter(p -> p.contains("riparabile.md") && p.contains("ERRORI DA CORREGGERE")).findFirst().orElseThrow();
        assertTrue(repairPrompt.contains("Dipendenze circolari"));
    }

    @Test
    void omittedConfigRequirementFoundByCoverageCheckIsAppliedWithoutAnotherModelRound() throws Exception {
        JsonNode job = generate("copertura-lacunosa.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(1, job.get("attempts").size(), "nessun tentativo di correzione: la patch si applica direttamente");
        assertEquals(1, job.get("appliedFixes").size());
        assertTrue(job.at("/appliedFixes/0").asText().startsWith("B_VERIFICA_DOCUMENTO: la specifica richiede un task manuale su KO"), job.at("/appliedFixes").toString());
        assertEquals("BO_DOCUMENTI", job.at("/modelOutput/offer/blocks/0/config/koTask/queue").asText());
        assertEquals(4, job.at("/offer/blocks/0/config/koTask/slaHours").asInt(), "lo SLA della specifica, non il default del catalogo (24)");
        assertEquals(0, job.get("warnings").size());
    }

    @Test
    void coverageFixKeepsOtherConfigAndResolvesMissingTemplate() throws Exception {
        JsonNode job = generate("copertura-template.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(1, job.get("attempts").size());
        JsonNode welcome = null;
        for (JsonNode b : job.at("/offer/blocks")) if ("B_BENVENUTO".equals(b.path("id").asText())) welcome = b;
        assertEquals("WELCOME_KIT", welcome.at("/config/inputMapping/template").asText());
        assertEquals("cliente.email", welcome.at("/config/inputMapping/email").asText(), "i campi già presenti non vengono toccati");
    }

    @Test
    void repairThatDropsExistingBlocksIsDiscardedAndLastGoodOfferKept() throws Exception {
        JsonNode full = JSON.readTree(FakeGemini.expected("famiglia.md"));
        JsonNode job = generate("copertura-troncata.md");
        assertEquals("WARNING", job.get("status").asText(), job.toString());
        assertEquals(3, job.get("attempts").size());
        assertTrue(job.at("/attempts/1/errors/0").asText().contains("ha eliminato elementi"), job.at("/attempts/1").toString());
        assertEquals(full.at("/offer/blocks").size(), job.at("/offer/blocks").size(), "la configurazione completa precedente viene mantenuta");
        assertEquals(full.at("/offer/gates").size(), job.at("/offer/gates").size());
        assertTrue(job.get("warnings").toString().contains("Controllo di copertura: B_VERIFICA_DOCUMENTO"));
    }

    @Test
    void gapsLeftAfterLastAttemptBecomeWarnings() throws Exception {
        JsonNode job = generate("copertura-ostinata.md");
        assertEquals("WARNING", job.get("status").asText(), job.toString());
        assertEquals(3, job.get("attempts").size());
        assertTrue(job.get("warnings").toString().contains("Controllo di copertura: B_VERIFICA_DOCUMENTO"), job.get("warnings").toString());
        assertFalse(job.get("files").isEmpty(), "l'offerta valida viene comunque restituita");
    }

    @Test
    void fixableWarningIsSentBackAndRepaired() throws Exception {
        JsonNode job = generate("template-mancante.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(2, job.get("attempts").size());
        assertEquals("REPAIR", job.at("/attempts/1/kind").asText());
        assertTrue(job.at("/attempts/0/errors/0").asText().contains("config.inputMapping.template"), job.at("/attempts/0").toString());
        JsonNode welcome = null;
        for (JsonNode b : job.at("/offer/blocks")) if ("B_BENVENUTO".equals(b.path("id").asText())) welcome = b;
        assertEquals("WELCOME_KIT", welcome.at("/config/inputMapping/template").asText());
    }

    @Test
    void unfixedWarningEndsAsWarningNotError() throws Exception {
        JsonNode job = generate("template-ostinato.md");
        assertEquals("WARNING", job.get("status").asText(), job.toString());
        assertEquals(3, job.get("attempts").size());
        assertTrue(job.get("warnings").toString().contains("input obbligatorio"));
        assertFalse(job.get("files").isEmpty(), "l'offerta valida con avvisi viene comunque restituita");
    }

    @Test
    void persistentErrorsEndInErrorAfterMaxAttempts() throws Exception {
        JsonNode job = generate("irreparabile.md");
        assertEquals("ERROR", job.get("status").asText());
        assertEquals(3, job.get("attempts").size());
        assertTrue(job.get("errors").get(0).asText().startsWith("Schema della risposta: "), job.get("errors").toString());
        assertTrue(job.get("files").isEmpty());
    }

    @Test
    void modelRejectionIsAnImmediateError() throws Exception {
        JsonNode job = generate("errore-modello.md");
        assertEquals("ERROR", job.get("status").asText());
        assertEquals(1, job.get("attempts").size());
        assertTrue(job.get("errors").get(0).asText().contains("400: API key not valid"), job.get("errors").toString());
    }

    @Test
    void transientModelErrorIsRetried() throws Exception {
        JsonNode job = generate("transitorio.md");
        assertEquals("SUCCESS", job.get("status").asText(), job.toString());
        assertEquals(1, job.get("attempts").size());
    }

    @Test
    void jsonInCodeFencesIsAccepted() throws Exception {
        assertEquals("SUCCESS", generate("con-recinto.md").get("status").asText());
    }

    @Test
    void everyGeminiCallIsLoggedWithoutKeyOrSpecContent() throws Exception {
        List<String> lines = new java.util.concurrent.CopyOnWriteArrayList<>();
        java.util.logging.Handler handler = new java.util.logging.Handler() {
            @Override
            public void publish(java.util.logging.LogRecord r) {
                lines.add(new java.util.logging.SimpleFormatter().formatMessage(r));
            }

            @Override
            public void flush() {
            }

            @Override
            public void close() {
            }
        };
        java.util.logging.Logger logger = java.util.logging.Logger.getLogger(GeminiOfferModel.class.getName());
        logger.addHandler(handler);
        try {
            assertEquals("SUCCESS", generate("conto-mono.md").get("status").asText());
            assertEquals("ERROR", generate("errore-modello.md").get("status").asText());
        } finally {
            logger.removeHandler(handler);
        }
        String all = String.join("\n", lines);
        assertTrue(all.matches("(?s).*gemini#\\d+ job=\\S+ richiesta: POST http://127.0.0.1:\\d+/v1beta/interactions model=gemini-fake .*promptChars=\\d+.*"), all);
        assertTrue(all.matches("(?s).*risposta: status=200 millis=\\d+ responseBytes=\\d+ textChars=\\d+.*"), all);
        assertTrue(all.matches("(?s).*risposta: status=400 millis=\\d+ .*retryable=false errore=API key not valid.*"), all);
        assertFalse(all.contains("test-key"), "la chiave non va nei log");
        assertFalse(all.contains("Controllo Cribis sul conto"), "il testo delle specifiche non va nei log");
    }

    @Test
    void invalidRequestsAreRejected() {
        given().contentType(ContentType.JSON).body("{\"fileName\":\"x.md\",\"specText\":\"  \",\"catalog\":{}}").when().post("/api/generations").then().statusCode(400);
        given().contentType(ContentType.JSON).body("{\"fileName\":\"x.md\",\"specText\":\"ciao\",\"catalog\":{}}").when().post("/api/generations").then().statusCode(400);
        given().when().get("/api/generations/inesistente").then().statusCode(404);
    }

    @Test
    void dashboardIsServedByTheBackend() {
        given().when().get("/generate.html").then().statusCode(200);
        given().when().get("/index.html").then().statusCode(200).body(org.hamcrest.Matchers.containsString("js/plan-graph.js"));
    }

    private static List<String> list(JsonNode a) {
        return JSON.convertValue(a, JSON.getTypeFactory().constructCollectionType(List.class, String.class));
    }
}
