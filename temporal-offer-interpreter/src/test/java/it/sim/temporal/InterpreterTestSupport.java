package it.sim.temporal;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.testing.TestEnvironmentOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.testing.WorkflowReplayer;
import io.temporal.worker.Worker;
import it.sim.temporal.activities.DefinitionRepository;
import it.sim.temporal.activities.EventActivitiesImpl;
import it.sim.temporal.app.InterpreterWorker;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.OfferInterpreterWorkflowImpl;

/**
 * Ambiente Temporal in memoria (nessun server esterno) con il worker dell'interprete, i servizi simulati e
 * le definizioni pubblicate. Tempo reale (niente time-skipping): le latenze dei servizi sono vere.
 */
abstract class InterpreterTestSupport {

    static final String TASK_QUEUE = "offer-interpreter-test";

    static TestWorkflowEnvironment env;
    static WorkflowClient client;
    static MockServices mock;
    static DefinitionRepository.InMemory definitions;
    static final List<String> emitted = new java.util.concurrent.CopyOnWriteArrayList<>();

    @BeforeAll
    static void startEnvironment() throws Exception {
        mock = new MockServices();
        definitions = new DefinitionRepository.InMemory();
        for (String f : TestFlows.ALL) definitions.publish(mock.rewrite(TestFlows.text(f)));
        env = TestWorkflowEnvironment.newInstance(TestEnvironmentOptions.newBuilder().setUseTimeskipping(false).build());
        Worker worker = env.newWorker(TASK_QUEUE);
        InterpreterWorker.register(worker, definitions, new EventActivitiesImpl(emitted::add));
        env.start();
        client = env.getWorkflowClient();
    }

    @AfterAll
    static void stopEnvironment() {
        if (env != null) env.close();
        if (mock != null) mock.close();
    }

    static OfferInterpreterWorkflow newWorkflow(String prefix) {
        return client.newWorkflowStub(OfferInterpreterWorkflow.class, WorkflowOptions.newBuilder()
                .setTaskQueue(TASK_QUEUE).setWorkflowId(prefix + "-" + UUID.randomUUID()).build());
    }

    /** Riesegue la storia registrata da Temporal: fallisce se l'interprete non è deterministico. */
    static void assertReplayable(String workflowId) throws Exception {
        WorkflowExecutionHistory history = client.fetchHistory(workflowId);
        WorkflowReplayer.replayWorkflowExecution(history, OfferInterpreterWorkflowImpl.class);
    }
}
