package it.sim.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Il codice JS della dashboard gira nel backend e produce lo stesso risultato del browser. */
class DashboardJsTest {

    static DashboardJs js;

    @BeforeAll
    static void start() {
        js = new DashboardJs();
    }

    @AfterAll
    static void stop() {
        js.close();
    }

    @Test
    void demoOfferIsValidAndExportsDsl() {
        JsonNode seed = js.seed();
        JsonNode offer = seed.get("offers").get(0);
        JsonNode r = js.analyze(seed, offer);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        assertEquals(2, r.get("files").size());
        assertTrue(r.at("/files/0/content").asText().contains("generator: offer-process-designer"));
        assertEquals("COMPLETED", r.at("/simulation/status").asText());
    }

    @Test
    void missingConfigIsFilledWithCatalogDefaults() {
        JsonNode seed = js.seed();
        ObjectNode offer = (ObjectNode) seed.get("offers").get(1).deepCopy();
        offer.withArray("blocks").forEach(b -> ((ObjectNode) b).remove("config"));
        JsonNode r = js.analyze(seed, offer);
        assertEquals(0, r.at("/validation/errors").size(), r.at("/validation/errors").toString());
        assertEquals("BO_DOCUMENTI", r.at("/offer/blocks/0/config/koTask/queue").asText());
    }

    @Test
    void incompatibleTaskIsAValidationError() {
        JsonNode seed = js.seed();
        ObjectNode offer = (ObjectNode) seed.get("offers").get(1).deepCopy();
        ((ObjectNode) offer.withArray("blocks").get(0)).put("taskId", "ORACOLO_2");
        JsonNode r = js.analyze(seed, offer);
        assertTrue(r.at("/validation/errors").toString().contains("non compatibile"), r.at("/validation/errors").toString());
        assertEquals(0, r.get("files").size());
    }
}
