package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.fasterxml.jackson.databind.ObjectMapper;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;
import io.temporal.testserver.TestServer;
import io.temporal.worker.WorkerFactory;
import it.sim.temporal.activities.DefinitionRepository;
import it.sim.temporal.app.InterpreterWorker;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.RunRequest;
import it.sim.temporal.workflow.RunResult;

/**
 * Worker reale (InterpreterWorker.start) collegato via gRPC a un server Temporal di test su una porta TCP, con le
 * definizioni lette da una cartella: una nuova versione copiata nella cartella è subito eseguibile, senza riavvio.
 */
class PublicationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void newVersionInTheFolderIsUsedWithoutRestartingTheWorker(@TempDir Path folder) throws Exception {
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        TestServer.PortBoundTestServer server = TestServer.createPortBoundServer(port);
        WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(WorkflowServiceStubsOptions.newBuilder().setTarget("127.0.0.1:" + port).build());
        WorkflowClient client = WorkflowClient.newInstance(service);
        WorkerFactory factory = InterpreterWorker.start(client, "publication-test", new DefinitionRepository.Directory(folder));
        try {
            String v1 = TestFlows.text("perimeter/flow.sw.yaml");
            Files.writeString(folder.resolve("flow-1.0.0.sw.yaml"), v1, StandardCharsets.UTF_8);
            RunResult first = start(client, null);
            assertEquals("test:flow:1.0.0", first.definition);
            assertEquals(6, JSON.readTree(first.outputJson).get("sum").asInt());

            // l'analista pubblica la 1.1.0: nessun build, nessun deploy, il worker resta acceso
            String v2 = v1.replace("version: \"1.0.0\"", "version: \"1.1.0\"").replace("while: ${ $n < 4 }", "while: ${ $n < 5 }");
            Files.writeString(folder.resolve("flow-1.1.0.sw.yaml"), v2, StandardCharsets.UTF_8);
            RunResult latest = start(client, null);
            assertEquals("test:flow:1.1.0", latest.definition);
            assertEquals(10, JSON.readTree(latest.outputJson).get("sum").asInt());

            // una pratica può ancora essere avviata sulla versione precedente
            RunResult pinned = start(client, "1.0.0");
            assertEquals("test:flow:1.0.0", pinned.definition);
        } finally {
            factory.shutdownNow();
            service.shutdownNow();
            server.close();
        }
    }

    private static RunResult start(WorkflowClient client, String version) {
        OfferInterpreterWorkflow wf = client.newWorkflowStub(OfferInterpreterWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue("publication-test").setWorkflowId("pub-" + UUID.randomUUID()).build());
        return wf.run(new RunRequest("test", "flow", version, "{}"));
    }
}
