package it.sim.temporal.app;

import io.temporal.client.WorkflowClient;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import it.sim.temporal.activities.DefinitionActivitiesImpl;
import it.sim.temporal.activities.DefinitionRepository;
import it.sim.temporal.activities.EventActivitiesImpl;
import it.sim.temporal.activities.HttpActivitiesImpl;
import it.sim.temporal.workflow.OfferInterpreterWorkflowImpl;

/**
 * Worker da deployare una sola volta: registra l'interprete e le activity. Le offerte sono solo definizioni pubblicate
 * nella cartella DEFINITIONS_DIR: una nuova offerta non richiede né build né deploy.
 *
 * Variabili d'ambiente: TEMPORAL_ADDRESS (default 127.0.0.1:7233), TEMPORAL_NAMESPACE (default "default"),
 * TASK_QUEUE (default "offer-interpreter"), DEFINITIONS_DIR (default "./definitions").
 */
public final class InterpreterWorker {

    private InterpreterWorker() {
    }

    public static void main(String[] args) {
        Settings s = Settings.fromEnv();
        WorkflowClient client = s.client();
        WorkerFactory factory = start(client, s.taskQueue(), new DefinitionRepository.Directory(s.definitionsDir()));
        System.out.println("Worker avviato: " + s.address() + " namespace=" + s.namespace() + " taskQueue=" + s.taskQueue()
                + " definizioni=" + s.definitionsDir().toAbsolutePath());
        Runtime.getRuntime().addShutdownHook(new Thread(factory::shutdown));
    }

    /** Registra workflow e activity sul task queue e avvia il worker. */
    public static WorkerFactory start(WorkflowClient client, String taskQueue, DefinitionRepository definitions) {
        WorkerFactory factory = WorkerFactory.newInstance(client);
        register(factory.newWorker(taskQueue), definitions, EventActivitiesImpl.logging());
        factory.start();
        return factory;
    }

    public static void register(Worker worker, DefinitionRepository definitions, EventActivitiesImpl events) {
        worker.registerWorkflowImplementationTypes(OfferInterpreterWorkflowImpl.class);
        worker.registerActivitiesImplementations(new HttpActivitiesImpl(), new DefinitionActivitiesImpl(definitions), events);
    }
}
