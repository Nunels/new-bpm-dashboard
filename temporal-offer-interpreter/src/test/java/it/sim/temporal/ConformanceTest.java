package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

/** I workflow eseguiti (generati e di prova) devono essere conformi allo schema ufficiale DSL 1.0.0. */
class ConformanceTest {

    private static JsonSchema schema() throws Exception {
        try (InputStream in = ConformanceTest.class.getResourceAsStream("/schema/workflow-1.0.0.yaml")) {
            JsonNode node = TestFlows.YAML.readTree(in);
            return JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(node);
        }
    }

    @Test
    void generatedAndPerimeterWorkflowsMatchTheOfficialSchema() throws Exception {
        JsonSchema schema = schema();
        List<String> files = new ArrayList<>(TestFlows.ALL);
        PerimeterTest.PERIMETER.forEach(f -> files.add("perimeter/" + f + ".sw.yaml"));
        for (String f : files) {
            Set<ValidationMessage> errors = schema.validate(TestFlows.yaml(f));
            assertEquals(Set.of(), errors, f);
        }
    }

    @Test
    void schemaRejectsAnInvalidWorkflow() throws Exception {
        JsonNode bad = TestFlows.YAML.readTree("document: { dsl: '1.0.0', namespace: x, name: bad }\ndo:\n  - x:\n      call: http\n");
        assertFalse(schema().validate(bad).isEmpty());
    }
}
