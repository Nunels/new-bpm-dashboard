package it.sim.temporal.dsl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Errore Serverless Workflow (Problem Details, RFC 7807): type, status, title, detail, instance.
 * Viaggia come eccezione dentro l'interprete e può essere catturato da un task "try".
 */
public final class WorkflowError extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public static final String BASE = "https://serverlessworkflow.io/spec/1.0.0/errors/";
    public static final String COMMUNICATION = BASE + "communication";
    public static final String EXPRESSION = BASE + "expression";
    public static final String VALIDATION = BASE + "validation";
    public static final String TIMEOUT = BASE + "timeout";
    public static final String RUNTIME = BASE + "runtime";

    private final transient ObjectNode error;

    public WorkflowError(ObjectNode error) {
        super(error.path("type").asText() + " " + error.path("status").asText() + ": " + error.path("title").asText()
                + (error.hasNonNull("detail") ? " - " + error.get("detail").asText() : ""));
        this.error = error;
    }

    public static WorkflowError of(String type, int status, String title, String detail, String instance) {
        ObjectNode e = JsonNodeFactory.instance.objectNode();
        e.put("type", type);
        e.put("status", status);
        e.put("title", title);
        if (detail != null) e.put("detail", detail);
        if (instance != null) e.put("instance", instance);
        return new WorkflowError(e);
    }

    /** Errore descritto nel workflow (task raise): l'istanza di default è il riferimento del task. */
    public static WorkflowError fromDefinition(JsonNode evaluated, String instance) {
        ObjectNode e = evaluated != null && evaluated.isObject() ? ((ObjectNode) evaluated).deepCopy() : JsonNodeFactory.instance.objectNode();
        if (!e.hasNonNull("instance")) e.put("instance", instance);
        return new WorkflowError(e);
    }

    public ObjectNode json() {
        return error.deepCopy();
    }

    public String type() {
        return error.path("type").asText();
    }

    public int status() {
        return error.path("status").asInt();
    }
}
