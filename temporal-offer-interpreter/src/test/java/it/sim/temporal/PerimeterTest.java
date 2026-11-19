package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.temporal.client.WorkflowFailedException;
import io.temporal.failure.ApplicationFailure;
import it.sim.temporal.dsl.DefinitionValidator;
import it.sim.temporal.expr.JqExpressionEngine;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.OfferInterpreterWorkflowImpl;
import it.sim.temporal.workflow.RunRequest;
import it.sim.temporal.workflow.RunResult;

/** Costrutti del perimetro oltre a quelli usati dagli scenari, e rifiuto di quelli fuori perimetro. */
class PerimeterTest extends InterpreterTestSupport {

    private static final ObjectMapper JSON = new ObjectMapper();
    static final List<String> PERIMETER = List.of("retry", "catch-do", "listen-timeout", "flow");

    @BeforeAll
    static void publish() {
        for (String f : PERIMETER) definitions.publish(mock.rewrite(TestFlows.text("perimeter/" + f + ".sw.yaml")));
        definitions.publish(TestFlows.text("invalid/out-of-perimeter.sw.yaml"));
    }

    @BeforeEach
    void reset() {
        mock.reset();
    }

    private static RunResult run(String namespace, String name, String input) {
        OfferInterpreterWorkflow wf = newWorkflow(name);
        return wf.run(new RunRequest(namespace, name, null, input));
    }

    @Test
    void retryRecoversFromTransientErrors() throws Exception {
        mock.failNext("ORACOLO", 2);
        RunResult r = run("test", "retry", "{}");
        assertEquals("COMPLETED", r.status, r.errorJson);
        assertEquals(3, mock.callsPerService().get("ORACOLO"));
        assertEquals("OK", JSON.readTree(r.outputJson).path("productOutcomes").path("CONTO").asText());
    }

    @Test
    void exhaustedRetriesFaultTheWorkflowWithACommunicationError() throws Exception {
        mock.failNext("ORACOLO", 10);
        RunResult r = run("test", "retry", "{}");
        assertEquals("FAULTED", r.status);
        JsonNode err = JSON.readTree(r.errorJson);
        assertEquals("https://serverlessworkflow.io/spec/1.0.0/errors/communication", err.get("type").asText());
        assertEquals(503, err.get("status").asInt());
        assertEquals("/do/0/check/try/0/invoke", err.get("instance").asText());
        assertEquals(3, mock.callsPerService().get("ORACOLO"));
    }

    @Test
    void catchDoHandlesTheErrorWithItsVariable() throws Exception {
        mock.failNext("ORACOLO", 1);
        RunResult r = run("test", "catch-do", "{}");
        assertEquals("COMPLETED", r.status, r.errorJson);
        assertEquals("{\"degraded\":true,\"status\":503}", r.outputJson);
    }

    @Test
    void listenTimesOut() throws Exception {
        long t0 = System.currentTimeMillis();
        RunResult r = run("test", "listen-timeout", "{}");
        assertEquals("FAULTED", r.status);
        JsonNode err = JSON.readTree(r.errorJson);
        assertEquals("https://serverlessworkflow.io/spec/1.0.0/errors/timeout", err.get("type").asText());
        assertEquals(408, err.get("status").asInt());
        assertTrue(System.currentTimeMillis() - t0 < 10000);
    }

    @Test
    void forWhileSwitchJumpAndEnd() throws Exception {
        OfferInterpreterWorkflow wf = newWorkflow("flow");
        RunResult r = wf.run(new RunRequest("test", "flow", "1.0.0", "{}"));
        assertEquals("COMPLETED", r.status, r.errorJson);
        JsonNode out = JSON.readTree(r.outputJson);
        assertEquals(6, out.get("sum").asInt());
        assertEquals("[0,1,2]", out.get("seen").toString());
        assertEquals("/do/4/done", out.get("task").asText());
        assertTrue(out.get("workflow").asText().startsWith("flow-"));
    }

    @Test
    void invalidWorkflowInputIsAValidationError() throws Exception {
        RunResult r = run("offers", "offer-off-sim", "{\"cliente\":{}}");
        assertEquals("FAULTED", r.status);
        JsonNode err = JSON.readTree(r.errorJson);
        assertEquals("https://serverlessworkflow.io/spec/1.0.0/errors/validation", err.get("type").asText());
        assertTrue(err.get("detail").asText().contains("pratica"), err.toString());
        assertTrue(mock.calls().isEmpty());
    }

    @Test
    void referenceWorkflowsAreInsideThePerimeter() {
        for (String f : TestFlows.ALL) {
            assertEquals(List.of(), DefinitionValidator.validate(TestFlows.yaml(f), new JqExpressionEngine()), f);
        }
        for (String f : PERIMETER) {
            assertEquals(List.of(), DefinitionValidator.validate(TestFlows.yaml("perimeter/" + f + ".sw.yaml"), new JqExpressionEngine()), f);
        }
    }

    @Test
    void outOfPerimeterDefinitionIsRejectedAtStartWithoutRetries() {
        List<String> problems = DefinitionValidator.validate(TestFlows.yaml("invalid/out-of-perimeter.sw.yaml"), new JqExpressionEngine());
        String all = String.join("\n", problems);
        for (String expected : List.of("/do/0/grpc/call: supportato solo call: http", "/do/1/race/fork/compete: compete: true non supportato",
                "/do/2/any-event/listen/to/any: non supportato", "/do/3/clock/set/at: funzione non deterministica non ammessa: now",
                "/do/4/broken/set/x: espressione jq non valida", "/do/5/jump/then: deve essere continue, exit, end o il nome di un task")) {
            assertTrue(all.contains(expected), "manca: " + expected + "\nproblemi:\n" + all);
        }
        WorkflowFailedException e = assertThrows(WorkflowFailedException.class, () -> run("test", "out-of-perimeter", "{}"));
        ApplicationFailure cause = assertInstanceOf(ApplicationFailure.class, e.getCause());
        assertEquals(OfferInterpreterWorkflowImpl.INVALID_DEFINITION, cause.getType());
        assertTrue(cause.isNonRetryable());
        assertTrue(cause.getOriginalMessage().contains("compete: true non supportato"), cause.getOriginalMessage());
    }

    @Test
    void unpublishedDefinitionFailsTheWorkflow() {
        WorkflowFailedException e = assertThrows(WorkflowFailedException.class, () -> run("test", "non-pubblicata", "{}"));
        assertTrue(String.valueOf(e.getCause().getCause()).contains("definizione non pubblicata"), String.valueOf(e.getCause()));
    }
}
