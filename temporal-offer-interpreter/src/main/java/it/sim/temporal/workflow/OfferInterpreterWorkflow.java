package it.sim.temporal.workflow;

import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * Unico workflow Temporal da deployare: esegue qualsiasi definizione Serverless Workflow 1.0 pubblicata,
 * nel perimetro di costrutti verificato da {@link it.sim.temporal.dsl.DefinitionValidator}.
 */
@WorkflowInterface
public interface OfferInterpreterWorkflow {

    @WorkflowMethod
    RunResult run(RunRequest request);

    /**
     * Evento esterno (CloudEvent in JSON: type, source, data, ...), per esempio la callback del ticket letta da Kafka.
     * Gli eventi restano in coda finché un task "listen" non li consuma: una callback arrivata in anticipo non va persa.
     */
    @SignalMethod
    void event(String cloudEventJson);

    /** Contesto corrente ($context) della pratica, per monitoraggio. */
    @QueryMethod
    String context();

    /** Riferimento del task in esecuzione (JSON Pointer), per monitoraggio. */
    @QueryMethod
    String currentTask();
}
