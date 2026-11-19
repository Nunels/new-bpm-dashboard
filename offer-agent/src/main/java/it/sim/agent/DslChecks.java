package it.sim.agent;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

import jakarta.enterprise.context.ApplicationScoped;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

import it.sim.temporal.dsl.DefinitionValidator;
import it.sim.temporal.expr.JqExpressionEngine;

/**
 * Controlli sul DSL generato: schema ufficiale Serverless Workflow 1.0.0 e perimetro dell'interprete Temporal
 * (gli stessi controlli che il worker fa all'avvio di una pratica).
 */
@ApplicationScoped
public class DslChecks {

    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private final JsonSchema schema;
    private final JqExpressionEngine jq = new JqExpressionEngine();

    public DslChecks() {
        try (InputStream in = DslChecks.class.getClassLoader().getResourceAsStream("workflow-1.0.0.yaml")) {
            schema = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(YAML.readTree(in));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Problemi del file YAML (vuoto = conforme e nel perimetro). */
    public List<String> check(String fileName, String yaml) {
        List<String> out = new ArrayList<>();
        JsonNode doc;
        try {
            doc = YAML.readTree(yaml);
        } catch (IOException e) {
            out.add(fileName + ": YAML non leggibile (" + e.getMessage() + ")");
            return out;
        }
        TreeSet<String> schemaErrors = new TreeSet<>();
        for (ValidationMessage m : schema.validate(doc)) schemaErrors.add(m.getMessage());
        schemaErrors.forEach(m -> out.add(fileName + ": schema DSL 1.0.0: " + m));
        DefinitionValidator.validate(doc, jq).forEach(p -> out.add(fileName + ": perimetro interprete: " + p));
        return out;
    }
}
