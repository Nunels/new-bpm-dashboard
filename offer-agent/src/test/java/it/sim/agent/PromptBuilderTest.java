package it.sim.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

class PromptBuilderTest {

    private static final ObjectMapper M = new ObjectMapper();

    @Test
    void taskWithManyFieldsIsCompacted() {
        ObjectNode catalog = M.createObjectNode();
        catalog.putArray("products").addObject().put("id", "CONTO").put("name", "Conto");
        ObjectNode task = catalog.putArray("tasks").addObject().put("id", "T").put("name", "Task");
        ArrayNode in = task.putArray("inputs");
        ArrayNode out = task.putArray("outputs");
        for (int i = 0; i < 100; i++) {
            in.addObject().put("name", "in" + i).put("required", i < 3).put("source", i == 0 ? "" : "cliente.campo" + i);
            out.addObject().put("name", "out" + i);
        }
        ArrayNode fields = catalog.putObject("practice").putArray("fields");
        for (int i = 0; i < 150; i++) fields.addObject().put("name", "cliente.campo" + i);

        JsonNode t = PromptBuilder.catalogForModel(catalog).path("tasks").get(0);
        assertEquals(1, t.path("inputsToProvide").size(), "solo l'input obbligatorio senza sorgente");
        assertEquals("in0", t.path("inputsToProvide").get(0).path("name").asText());
        assertEquals(100, t.path("inputsTotal").asInt());
        assertEquals(12, t.path("outputs").size());
        assertEquals(100, t.path("outputsTotal").asInt());
        assertFalse(t.has("inputs"));
        assertEquals(80, PromptBuilder.catalogForModel(catalog).path("practiceFields").size());
    }
}
