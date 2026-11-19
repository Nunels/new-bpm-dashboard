package it.sim.temporal.workflow;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ApplicationFailure;
import io.temporal.workflow.Workflow;
import it.sim.temporal.activities.DefinitionActivities;
import it.sim.temporal.dsl.DefinitionValidator;
import it.sim.temporal.expr.ExpressionEngine;
import it.sim.temporal.expr.JqExpressionEngine;

public class OfferInterpreterWorkflowImpl implements OfferInterpreterWorkflow {

    /** Tipo dell'errore Temporal per definizioni illeggibili o fuori perimetro: il workflow fallisce senza retry. */
    public static final String INVALID_DEFINITION = "InvalidDefinition";

    private static final ExpressionEngine JQ = new JqExpressionEngine();
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Logger LOG = Workflow.getLogger(OfferInterpreterWorkflowImpl.class);

    private final List<JsonNode> events = new ArrayList<>();
    private final Interpreter interpreter = new Interpreter(JQ, events);

    @Override
    public RunResult run(RunRequest request) {
        DefinitionActivities definitions = Workflow.newActivityStub(DefinitionActivities.class, ActivityOptions.newBuilder()
                .setStartToCloseTimeout(Duration.ofSeconds(30))
                .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(5).build()).build());
        String yaml = definitions.load(request.namespace, request.name, request.version);

        JsonNode definition;
        try {
            definition = YAML.readTree(yaml);
        } catch (IOException e) {
            throw ApplicationFailure.newNonRetryableFailure("YAML non leggibile per " + request.ref() + ": " + e.getMessage(), INVALID_DEFINITION);
        }
        List<String> problems = DefinitionValidator.validate(definition, JQ);
        if (!problems.isEmpty()) {
            throw ApplicationFailure.newNonRetryableFailure("Definizione " + request.ref() + " fuori dal perimetro supportato:\n- "
                    + String.join("\n- ", problems), INVALID_DEFINITION, problems);
        }
        JsonNode doc = definition.get("document");
        String ref = doc.get("namespace").asText() + ":" + doc.get("name").asText() + ":" + doc.get("version").asText();

        JsonNode input;
        try {
            input = request.inputJson == null ? JsonNodeFactory.instance.objectNode() : JSON.readTree(request.inputJson);
        } catch (IOException e) {
            throw ApplicationFailure.newNonRetryableFailure("input non è JSON valido: " + e.getMessage(), INVALID_DEFINITION);
        }
        return interpreter.execute(definition, input, ref);
    }

    @Override
    public void event(String cloudEventJson) {
        try {
            JsonNode event = JSON.readTree(cloudEventJson);
            if (event != null && event.isObject()) events.add(event);
            else LOG.warn("evento ignorato: non è un oggetto JSON");
        } catch (IOException e) {
            LOG.warn("evento ignorato: JSON non valido ({})", e.getMessage());
        }
    }

    @Override
    public String context() {
        return interpreter.context().toString();
    }

    @Override
    public String currentTask() {
        return interpreter.currentTask();
    }
}
