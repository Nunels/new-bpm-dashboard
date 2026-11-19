package it.sim.temporal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import it.sim.temporal.expr.Expressions;
import it.sim.temporal.expr.JqExpressionEngine;

class JqExpressionEngineTest {

    private static final ObjectMapper M = new ObjectMapper();
    private final JqExpressionEngine jq = new JqExpressionEngine();

    @Test
    void allExpressionsOfTheReferenceWorkflowsCompile() throws Exception {
        List<String> failures = new ArrayList<>();
        int count = 0;
        for (String f : TestFlows.ALL) {
            List<String> exprs = new ArrayList<>();
            collect(TestFlows.yaml(f), exprs);
            for (String e : exprs) {
                count++;
                try {
                    jq.check(Expressions.body(e));
                } catch (RuntimeException ex) {
                    failures.add(f + ": " + ex.getMessage());
                }
            }
        }
        assertTrue(count > 50, "trovate solo " + count + " espressioni");
        assertTrue(failures.isEmpty(), String.join("\n", failures));
    }

    private static void collect(JsonNode n, List<String> out) {
        if (Expressions.isExpression(n)) out.add(n.asText());
        else if (n.isContainerNode()) n.forEach(c -> collect(c, out));
    }

    @Test
    void koProductsAreExtractedFromProductOutcomes() throws Exception {
        JsonNode ctx = M.readTree("{\"koProducts\":[\"TIM\"],\"esiti\":{},\"koByBlock\":{}}");
        JsonNode out = M.readTree("{\"productOutcomes\":{\"CONTO\":\"KO\",\"EVO\":\"OK\",\"TIM\":\"KO\"}}");
        String expr = "$context + { koProducts: ((($context.koProducts // []) + [($output.productOutcomes // {}) | to_entries[] | select(.value == \"KO\") | .key]) | unique) }";
        JsonNode r = jq.evaluate(expr, out, Map.of("context", ctx, "output", out));
        assertEquals("[\"CONTO\",\"TIM\"]", r.get("koProducts").toString());
    }

    @Test
    void productFilterAndDifferenceWork() throws Exception {
        JsonNode ctx = M.readTree("{\"activeProducts\":[\"CONTO\",\"EVO\",\"TIM\"],\"koByBlock\":{\"B_ORACOLO\":[\"EVO\"]}}");
        String expr = "([$context.activeProducts[] | select((. == \"CONTO\" or . == \"EVO\"))] - (($context.koByBlock[\"B_ORACOLO\"] // [])))";
        assertEquals("[\"CONTO\"]", jq.evaluate(expr, null, Map.of("context", ctx)).toString());
        assertEquals("0", jq.evaluate("([] | length)", null, Map.of()).toString());
    }

    @Test
    void uriEncodingAndToString() {
        JsonNode r = jq.evaluate("\"http://x/rating/\" + ((\"RSS MRA/1\") | tostring | @uri)", null, Map.of());
        assertEquals("http://x/rating/RSS%20MRA%2F1", r.asText());
    }

    @Test
    void nonDeterministicFunctionsAreDetected() {
        assertEquals("now", Expressions.nonDeterministic("now | todate"));
        assertNull(Expressions.nonDeterministic("$workflow.input.pratica.id"));
        assertNull(Expressions.nonDeterministic("{ input: 1, now: 2 }"));
    }
}
