package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.fail;

import java.io.InputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Stream;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.temporal.client.WorkflowOptions;
import it.sim.temporal.app.OfferOutcome;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.RunRequest;
import it.sim.temporal.workflow.RunResult;

/**
 * Gli stessi scenari di quarkus-flow-sim (esiti attesi calcolati dal simulatore della dashboard), eseguiti dal
 * worker Temporal sugli stessi YAML Serverless Workflow 1.0. Confronta stato finale, prodotti attivi, chiamate per
 * servizio, prodotti inviati a ogni servizio e, per "Non attendere", il tempo; poi riesegue la storia (replay).
 */
class ScenarioTest extends InterpreterTestSupport {

    private static final ObjectMapper JSON = new ObjectMapper();

    static Stream<Arguments> scenarios() throws Exception {
        try (InputStream in = ScenarioTest.class.getResourceAsStream("/scenarios.json")) {
            List<Arguments> list = new ArrayList<>();
            JSON.readTree(in).forEach(sc -> list.add(Arguments.of(sc.get("offerId").asText() + "/" + sc.get("name").asText(), sc)));
            return list.stream();
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String label, JsonNode sc) throws Exception {
        mock.configure(sc.get("mock"), sc.get("latency"));
        String[] wf = sc.get("workflow").asText().split(":");
        String workflowId = "pratica-" + label.replace('/', '-') + "-" + UUID.randomUUID();
        OfferInterpreterWorkflow stub = client.newWorkflowStub(OfferInterpreterWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TASK_QUEUE).setWorkflowId(workflowId).build());

        long t0 = System.currentTimeMillis();
        RunResult result = stub.run(new RunRequest(wf[0], wf[1], "1.0.0", sc.get("input").toString()));
        long elapsed = System.currentTimeMillis() - t0;
        OfferOutcome outcome = OfferOutcome.of(result);

        // i rami "non attesi" continuano dopo la fine della pratica: aspetto le loro chiamate prima di confrontare
        Map<String, Integer> expCalls = new TreeMap<>();
        sc.get("expectedCalls").fields().forEachRemaining(e -> { if (e.getValue().asInt() > 0) expCalls.put(e.getKey(), e.getValue().asInt()); });
        mock.await(m -> m.callsPerService().equals(expCalls) && m.inFlight() == 0, Duration.ofSeconds(15));

        List<String> problems = new ArrayList<>();
        String expStatus = sc.get("expected").get("status").asText();
        if (!expStatus.equals(outcome.status())) problems.add("stato: atteso " + expStatus + " ma ottenuto " + outcome.status());

        TreeSet<String> expActive = new TreeSet<>();
        sc.get("expected").get("activeProducts").forEach(n -> expActive.add(n.asText()));
        TreeSet<String> gotActive = new TreeSet<>(outcome.activeProducts());
        if (!expActive.equals(gotActive)) problems.add("prodotti attivi: attesi " + expActive + " ma ottenuti " + gotActive);

        Map<String, Integer> gotCalls = mock.callsPerService();
        if (!expCalls.equals(gotCalls)) problems.add("chiamate per servizio: attese " + expCalls + " ma ottenute " + gotCalls);

        Map<String, TreeSet<String>> gotProducts = new TreeMap<>();
        mock.calls().forEach(c -> gotProducts.computeIfAbsent(c.service(), k -> new TreeSet<>()).addAll(c.products()));
        Map<String, TreeSet<String>> expProducts = new TreeMap<>();
        sc.get("expectedProducts").fields().forEachRemaining(e -> {
            TreeSet<String> set = new TreeSet<>();
            e.getValue().forEach(p -> set.add(p.asText()));
            if (!set.isEmpty()) expProducts.put(e.getKey(), set);
        });
        if (!expProducts.equals(gotProducts)) problems.add("prodotti inviati ai servizi: attesi " + expProducts + " ma ottenuti " + gotProducts);

        if (sc.hasNonNull("maxMillis") && elapsed > sc.get("maxMillis").asLong()) {
            problems.add("tempo: " + elapsed + " ms oltre il massimo di " + sc.get("maxMillis").asLong() + " ms (Non attendere non ha funzionato)");
        }

        assertReplayable(workflowId);

        System.out.println("### " + label + " -> " + elapsed + " ms, " + (problems.isEmpty() ? "OK" : "DIFFERENZE") + " | stato " + outcome.status()
                + " | output " + result.outputJson + (result.errorJson != null ? " | errore " + result.errorJson : ""));
        if (!problems.isEmpty()) fail(String.join("\n", problems));
    }
}
