package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import it.sim.temporal.app.OfferOutcome;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.RunRequest;
import it.sim.temporal.workflow.RunResult;

/**
 * Offerta completa della dashboard (OFF_BUNDLE), esportata dal target Temporal: back office e attivazione TIM
 * asincroni (chiamata + callback), "KO con task" (emit della richiesta + attesa del completamento), Oracolo 2 non atteso.
 * Le callback che in produzione arrivano da Kafka sono simulate con il signal "event".
 */
class BundleCallbackTest extends InterpreterTestSupport {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String INPUT = "{\"pratica\":{\"id\":\"PRA-1\"},\"cliente\":{\"codiceFiscale\":\"RSSMRA80A01H501U\","
            + "\"email\":\"mario.rossi@example.com\",\"documento\":{\"tipo\":\"CI\",\"numero\":\"AX1\",\"scadenza\":\"2030-01-01\"}}}";

    @BeforeEach
    void reset() {
        mock.reset();
        emitted.clear();
    }

    private String event(String type, String data) {
        ObjectNode e = JSON.createObjectNode().put("specversion", "1.0").put("id", UUID.randomUUID().toString()).put("source", "test").put("type", type);
        try {
            e.set("data", JSON.readTree(data));
        } catch (Exception ex) {
            throw new IllegalArgumentException(ex);
        }
        return e.toString();
    }

    private void awaitCall(String service) throws InterruptedException {
        assertTrue(mock.await(m -> m.callsPerService().containsKey(service), Duration.ofSeconds(15)), "nessuna chiamata a " + service);
    }

    @Test
    void callbacksAndManualTaskCompleteTheOffer() throws Exception {
        String id = "pratica-bundle-" + UUID.randomUUID();
        OfferInterpreterWorkflow wf = client.newWorkflowStub(OfferInterpreterWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TASK_QUEUE).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new RunRequest("offers", "offer-off-bundle", null, INPUT));

        // presa in carico BO: il back office risponde "KO con task" su Conto
        awaitCall("PRESA_IN_CARICO_BO");
        wf.event(event("bo.pratiche.esiti", "{\"praticaId\":\"PRA-1\",\"productOutcomes\":{\"CONTO\":\"KO_TASK\",\"EVO\":\"OK\",\"LIBMIN\":\"OK\",\"TIM\":\"OK\"}}"));

        // il workflow emette la richiesta di task manuale sulla coda configurata in dashboard e aspetta il completamento
        assertTrue(awaitEmitted("manual-task.requested"), "richiesta di task manuale non emessa");
        JsonNode request = JSON.readTree(emitted.stream().filter(e -> e.contains("manual-task.requested")).findFirst().orElseThrow());
        assertEquals("BO_RILAVORAZIONE", request.path("data").path("queue").asText());
        assertEquals("B_BO", request.path("data").path("activityId").asText());
        assertEquals("PRA-1", request.path("data").path("praticaId").asText());
        assertTrue(wf.currentTask().contains("await-manual-task"), "task corrente: " + wf.currentTask());
        wf.event(event("manual-task.completed", "{\"activityId\":\"B_BO\",\"productOutcomes\":{\"CONTO\":\"OK\",\"EVO\":\"OK\",\"LIBMIN\":\"OK\",\"TIM\":\"OK\"}}"));

        // attivazione TIM presso il partner: esito via callback
        awaitCall("ATTIVAZIONE_TIM");
        wf.event(event("partner.tim.attivazioni", "{\"praticaId\":\"PRA-1\",\"productOutcomes\":{\"TIM\":\"OK\"}}"));

        RunResult result = WorkflowStub.fromTyped(wf).getResult(RunResult.class);
        OfferOutcome outcome = OfferOutcome.of(result);
        assertEquals("COMPLETED", outcome.status(), "errore: " + result.errorJson);
        assertEquals(List.of("CONTO", "EVO", "LIBMIN", "TIM"), outcome.activeProducts());
        assertEquals("offers:offer-off-bundle:1.0.0", result.definition);
        assertEquals(1, mock.callsPerService().get("COMUNICAZIONI"));

        // ramo non atteso (Oracolo 2): child workflow abbandonato dal padre, che termina comunque
        RunResult child = client.newUntypedWorkflowStub(id + "/1-offer-off-bundle-b-oracolo2").getResult(RunResult.class);
        assertEquals("COMPLETED", child.status);
        assertNotNull(JSON.readTree(child.outputJson));

        assertReplayable(id);
    }

    @Test
    void callbackWithKoStopsTheOfferAtTheBoGate() throws Exception {
        String id = "pratica-bundle-ko-" + UUID.randomUUID();
        OfferInterpreterWorkflow wf = client.newWorkflowStub(OfferInterpreterWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TASK_QUEUE).setWorkflowId(id).build());
        // la callback arriva prima che il workflow la attenda: resta in coda e viene consumata dal listen
        WorkflowClient.start(wf::run, new RunRequest("offers", "offer-off-bundle", "1.0.0", INPUT));
        wf.event(event("bo.pratiche.esiti", "{\"praticaId\":\"ALTRA-PRATICA\",\"productOutcomes\":{\"CONTO\":\"OK\"}}"));
        wf.event(event("bo.pratiche.esiti", "{\"praticaId\":\"PRA-1\",\"productOutcomes\":{\"CONTO\":\"OK\",\"EVO\":\"KO\",\"LIBMIN\":\"OK\",\"TIM\":\"OK\"}}"));

        RunResult result = WorkflowStub.fromTyped(wf).getResult(RunResult.class);
        OfferOutcome outcome = OfferOutcome.of(result);
        assertEquals("STOPPED", outcome.status(), "risultato: " + result.outputJson + " " + result.errorJson);
        assertTrue(!mock.callsPerService().containsKey("ATTIVAZIONE_BANCARIA"), "nessuna attivazione dopo lo stop");
        assertTrue(wf.context().contains("\"koProducts\":[\"EVO\"]"), "contesto: " + wf.context());
        assertReplayable(id);
    }

    private boolean awaitEmitted(String type) throws InterruptedException {
        long end = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < end) {
            if (emitted.stream().anyMatch(e -> e.contains(type))) return true;
            Thread.sleep(50);
        }
        return false;
    }
}
