package it.sim.temporal.workflow;

/**
 * Esito di un workflow.
 * COMPLETED: output = output dell'ultimo task. FAULTED: errore Serverless Workflow non gestito (raise, retry esauriti,
 * timeout di un listen, input non valido): error = Problem Details. Le definizioni non valide invece fanno fallire
 * il workflow Temporal, perché sono un difetto della pubblicazione e non un esito della pratica.
 */
public final class RunResult {

    public String status;
    public String outputJson;
    public String errorJson;
    /** Definizione eseguita (namespace:name:version), utile per audit. */
    public String definition;

    public RunResult() {
    }

    static RunResult completed(String definition, String outputJson) {
        RunResult r = new RunResult();
        r.status = "COMPLETED";
        r.definition = definition;
        r.outputJson = outputJson;
        return r;
    }

    static RunResult faulted(String definition, String errorJson) {
        RunResult r = new RunResult();
        r.status = "FAULTED";
        r.definition = definition;
        r.errorJson = errorJson;
        return r;
    }
}
