package it.sim.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import it.sim.temporal.expr.JqExpressionEngine;

/** Il DSL generato per blocchi condizionali (when) e instradamenti dei gate (ROUTE) è valido: schema DSL 1.0.0 e perimetro dell'interprete. */
class DslChecksTest {

    static DashboardJs js;
    static final DslChecks dsl = new DslChecks();
    static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void start() {
        js = new DashboardJs();
    }

    @AfterAll
    static void stop() {
        js.close();
    }

    private static ObjectNode block(ObjectNode offer, String id) {
        for (JsonNode b : offer.withArray("blocks")) if (id.equals(b.get("id").asText())) return (ObjectNode) b;
        throw new IllegalStateException("blocco " + id);
    }

    private static ObjectNode gate(ObjectNode offer, String id) {
        for (JsonNode g : offer.withArray("gates")) if (id.equals(g.get("id").asText())) return (ObjectNode) g;
        throw new IllegalStateException("gate " + id);
    }

    private static JsonNode when(String clauses) throws Exception {
        return JSON.readTree("{\"join\":\"AND\",\"clauses\":" + clauses + "}");
    }

    @Test
    void demoOfferWithAllFeaturesProducesValidDsl() {
        JsonNode seed = js.seed();
        JsonNode demo = null;
        for (JsonNode o : seed.get("offers")) if ("OFF_DEMO".equals(o.get("id").asText())) demo = o;
        JsonNode r = js.analyze(seed, demo);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        assertEquals(List.of(), problems(r));
        assertTrue(r.at("/files").size() >= 2, "ramo non atteso in un sotto-workflow");
    }

    @Test
    void independentBranchesAndJoinProduceValidDsl() throws Exception {
        JsonNode seed = js.seed();
        ObjectNode offer = (ObjectNode) seed.get("offers").get(0).deepCopy();
        // Verticali: Cribis → Stampa e Pregiudizievoli → Stampa (rami indipendenti), più un join
        for (JsonNode b : offer.withArray("blocks")) if ("B_CRIBIS".equals(b.get("id").asText())) ((ObjectNode) b).put("stepId", "VERTICALI");
        offer.withArray("blocks")
                .add(JSON.readTree("{\"id\":\"B_PREG2\",\"taskId\":\"PREGIUDIZIEVOLI\",\"stepId\":\"VERTICALI\",\"products\":[\"CONTO\",\"EVO\"],\"dependsOn\":[]}"))
                .add(JSON.readTree("{\"id\":\"B_T1\",\"taskId\":\"STAMPA_CONTRATTI\",\"stepId\":\"VERTICALI\",\"products\":[\"CONTO\"],\"dependsOn\":[\"B_CRIBIS\"]}"))
                .add(JSON.readTree("{\"id\":\"B_T2\",\"taskId\":\"STAMPA_CONTRATTI\",\"stepId\":\"VERTICALI\",\"products\":[\"CONTO\",\"EVO\"],\"dependsOn\":[\"B_PREG2\"]}"))
                .add(JSON.readTree("{\"id\":\"B_T3\",\"taskId\":\"STAMPA_CONTRATTI\",\"stepId\":\"VERTICALI\",\"products\":[\"CONTO\"],\"dependsOn\":[\"B_CRIBIS\"]}"));
        JsonNode r = js.analyze(seed, offer);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        String main = r.at("/files/0/content").asText();
        assertTrue(main.contains("verticali-branches") && main.contains("verticali-fork-b-cribis"), main);
        assertEquals(List.of(), problems(r));

        ((ObjectNode) offer.withArray("blocks").get(offer.withArray("blocks").size() - 1)).putArray("dependsOn").add("B_CRIBIS").add("B_PREG2");
        JsonNode joined = js.analyze(seed, offer);
        assertEquals(0, joined.at("/validation/errors").size(), joined.at("/validation/errors").toString());
        assertEquals(List.of(), problems(joined));
    }

    @Test
    void listsInInputAndOutputProduceValidDslWithWorkingJq() throws Exception {
        ObjectNode seed = (ObjectNode) js.seed().deepCopy();
        seed.withArray("/practice/fields").add(JSON.readTree("{\"name\":\"pratica.spedizioni[].destinatario.cap\",\"type\":\"string\"}"))
                .add(JSON.readTree("{\"name\":\"pratica.spedizioni[].colli[].peso\",\"type\":\"number\"}"));
        for (JsonNode t : seed.get("tasks")) {
            if (!"PRESA_IN_CARICO_BO".equals(t.get("id").asText())) continue;
            ((ObjectNode) t).withArray("inputs")
                    .add(JSON.readTree("{\"name\":\"spedizioni[]\",\"type\":\"array\",\"source\":\"pratica.spedizioni[]\"}"))
                    .add(JSON.readTree("{\"name\":\"spedizioni[].cap\",\"source\":\"@.destinatario.cap\"}"))
                    .add(JSON.readTree("{\"name\":\"spedizioni[].colli[]\",\"type\":\"array\",\"source\":\"@.colli[]\"}"))
                    .add(JSON.readTree("{\"name\":\"spedizioni[].colli[].peso\",\"source\":\"@.peso\"}"))
                    .add(JSON.readTree("{\"name\":\"tuttiCap\",\"type\":\"array\",\"source\":\"pratica.spedizioni[].destinatario.cap\"}"))
                    .add(JSON.readTree("{\"name\":\"tuttiPesi\",\"type\":\"array\",\"source\":\"pratica.spedizioni[].colli[].peso\"}"));
        }
        ObjectNode offerNode = (ObjectNode) seed.get("offers").get(0).deepCopy();
        ((ObjectNode) block(offerNode, "B_WELCOME").withObject("/config")).set("when", when(
                "[{\"left\":\"esiti.B_ORACOLO.risultati[].esito\",\"op\":\"allEq\",\"value\":\"OK\"},"
                + "{\"left\":\"esiti.B_ORACOLO.risultati[].esito\",\"op\":\"anyNe\",\"value\":\"KO\"},"
                + "{\"left\":\"esiti.B_ORACOLO.risultati[].score\",\"op\":\"countGte\",\"value\":\"2\"},"
                + "{\"left\":\"pratica.spedizioni[].destinatario.cap\",\"op\":\"noneEq\",\"value\":\"00000\"}]"));
        JsonNode r = js.analyze(seed, offerNode);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        assertEquals(List.of(), problems(r));

        JsonNode main = YAML.readTree(r.at("/files/0/content").asText());
        JqExpressionEngine jq = new JqExpressionEngine();
        JsonNode vars = JSON.readTree("{\"workflow\":{\"input\":{\"pratica\":{\"spedizioni\":["
                + "{\"destinatario\":{\"cap\":\"00144\"},\"colli\":[{\"peso\":1},{\"peso\":2}]},"
                + "{\"destinatario\":{\"cap\":\"46019\"},\"colli\":[{\"peso\":3}]}]}}},"
                + "\"context\":{\"activeProducts\":[\"CONTO\",\"EVO\",\"LIBMIN\",\"TIM\"]}}");
        java.util.Map<String, JsonNode> vs = java.util.Map.of("workflow", vars.get("workflow"), "context", vars.get("context"));

        JsonNode bo = call(main, "b-bo-call").at("/with/body");
        assertEquals(JSON.readTree("[{\"cap\":\"00144\",\"colli\":[{\"peso\":1},{\"peso\":2}]},{\"cap\":\"46019\",\"colli\":[{\"peso\":3}]}]"),
                jq.evaluate(expr(bo.get("spedizioni")), null, vs));
        assertEquals(JSON.readTree("[\"00144\",\"46019\"]"), jq.evaluate(expr(bo.get("tuttiCap")), null, vs));
        assertEquals(JSON.readTree("[1,2,3]"), jq.evaluate(expr(bo.get("tuttiPesi")), null, vs));

        // un elemento per prodotto del blocco, e productOutcomes ricavato dalla lista risultati per prodotto
        JsonNode oracolo = call(main, "b-oracolo-call");
        assertEquals(JSON.readTree("[{\"id\":\"CONTO\"},{\"id\":\"EVO\"},{\"id\":\"LIBMIN\"}]"), jq.evaluate(expr(oracolo.at("/with/body/prodotti")), null, vs));
        String outputAs = expr(oracolo.at("/output/as"));
        JsonNode out = jq.evaluate(outputAs, JSON.readTree("{\"risultati\":[{\"prodotto\":\"CONTO\",\"esito\":\"OK\"},{\"prodotto\":\"EVO\",\"esito\":\"KO\"}]}"), java.util.Map.of());
        assertEquals(JSON.readTree("{\"CONTO\":\"OK\",\"EVO\":\"KO\"}"), out.get("productOutcomes"));
        JsonNode legacy = jq.evaluate(outputAs, JSON.readTree("{\"productOutcomes\":{\"CONTO\":\"KO\"}}"), java.util.Map.of());
        assertEquals(JSON.readTree("{\"CONTO\":\"KO\"}"), legacy.get("productOutcomes"));
    }

    private static final ObjectMapper YAML = new ObjectMapper(new com.fasterxml.jackson.dataformat.yaml.YAMLFactory());

    private static String expr(JsonNode v) {
        String s = v.asText().trim();
        return s.substring(2, s.length() - 1).trim();
    }

    /** Chiamata http del blocco (con retry è dentro try/invoke). */
    private static JsonNode call(JsonNode node, String name) {
        if (node.has(name)) {
            JsonNode n = node.get(name);
            return n.has("call") ? n : n.at("/try/0/invoke");
        }
        for (JsonNode c : node) {
            JsonNode r = call(c, name);
            if (r != null && !r.isMissingNode()) return r;
        }
        return null;
    }

    private List<String> problems(JsonNode analysis) {
        List<String> out = new ArrayList<>();
        analysis.get("files").forEach(f -> out.addAll(dsl.check(f.get("name").asText(), f.get("content").asText())));
        return out;
    }

    @Test
    void conditionalBlocksAndRoutesProduceValidDsl() throws Exception {
        JsonNode seed = js.seed();
        ObjectNode offer = (ObjectNode) seed.get("offers").get(0).deepCopy();

        ((ObjectNode) block(offer, "B_CRIBIS").withObject("/config")).set("when",
                when("[{\"left\":\"cliente.documento.tipo\",\"op\":\"in\",\"value\":\"CI, PASS\"},{\"left\":\"esito.B_PREGIUDIZIEVOLI\",\"op\":\"==\",\"value\":\"OK\"}]"));
        ((ObjectNode) block(offer, "B_WELCOME").withObject("/config")).set("when",
                when("[{\"left\":\"offerta.prodotti\",\"op\":\"contains\",\"value\":\"CONTO\"},{\"left\":\"esiti.B_ORACOLO.esitoOracolo\",\"op\":\"!=\",\"value\":\"KO\"}]"));

        // ritorno indietro con limite, salto in avanti e stop condizionale
        gate(offer, "G_VER_1").withArray("rules").add(JSON.readTree(
                "{\"type\":\"ROUTE\",\"to\":\"PRELIMINARI\",\"maxIterations\":2,\"onExceed\":\"STOP\",\"when\":{\"join\":\"OR\",\"clauses\":[{\"left\":\"esito.B_CRIBIS\",\"op\":\"==\",\"value\":\"KO\"},{\"left\":\"esiti.B_ORACOLO.scoreRischio\",\"op\":\"contains\",\"value\":\"ALTO\"}]}}"));
        gate(offer, "G_PRE_2").withArray("rules").add(JSON.readTree(
                "{\"type\":\"ROUTE\",\"to\":\"BO\",\"maxIterations\":3,\"onExceed\":\"STOP\",\"when\":{\"join\":\"AND\",\"clauses\":[{\"left\":\"cliente.email\",\"op\":\"nexists\",\"value\":\"\"}]}}"));
        gate(offer, "G_BO_1").withArray("rules").add(JSON.readTree(
                "{\"type\":\"ROUTE\",\"to\":\"STOP\",\"when\":{\"join\":\"AND\",\"clauses\":[{\"left\":\"cliente.documento.tipo\",\"op\":\"==\",\"value\":\"NONE\"}]}}"));

        JsonNode r = js.analyze(seed, offer);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        String main = r.at("/files/0/content").asText();
        assertTrue(main.contains("gate-verticali-route") && main.contains("gate-verticali-go-1") && main.contains("gate-preliminari-skip"), main);
        assertEquals(List.of(), problems(r));
    }
}
