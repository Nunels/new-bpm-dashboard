package it.sim.java;

import static io.quarkiverse.flow.dsl.FlowDSL.function;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.UnaryOperator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.quarkiverse.flow.dsl.FlowWorkflowBuilder;
import io.quarkiverse.flow.dsl.configurers.FuncTaskConfigurer;
import io.serverlessworkflow.api.types.Workflow;

/**
 * Costruisce con il Java DSL di Quarkus Flow un workflow a partire dall'Execution Plan (JSON) della dashboard.
 * Ogni attività e ogni barra regole è una funzione Java (vedi {@link OfferInterpreter}).
 */
public final class PlanFlow {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String NAMESPACE = "offers-java";

    private PlanFlow() {
    }

    @SuppressWarnings({ "rawtypes", "unchecked" })
    private static FuncTaskConfigurer task(String name, UnaryOperator<Map<String, Object>> op) {
        return function(name, (Function<Map, Map>) m -> op.apply((Map<String, Object>) m), Map.class, Map.class);
    }

    private static String id(String s) {
        return s.toLowerCase().replace('_', '-');
    }

    public static Workflow build(String offerId, String name) {
        JsonNode plan = read("/plans/" + offerId + ".plan.json");
        List<String> products = new ArrayList<>();
        plan.path("products").forEach(p -> products.add(p.get("id").asText()));

        List<FuncTaskConfigurer> tasks = new ArrayList<>();
        tasks.add(task("init-offer", in -> OfferInterpreter.init(in, products)));

        for (JsonNode step : plan.path("steps")) {
            String s = id(step.get("stepId").asText());
            JsonNode gate = step.path("exitGate");
            Set<String> detached = new HashSet<>();
            gate.at("/effectivePolicy/dontWait").forEach(d -> detached.add(d.asText()));

            List<JsonNode> main = new ArrayList<>();
            for (JsonNode stage : step.path("stages")) {
                List<JsonNode> acts = new ArrayList<>();
                for (JsonNode a : stage.path("activities")) {
                    if (detached.contains(a.get("activityId").asText())) {
                        tasks.add(task("detached-" + id(a.get("activityId").asText()), st -> OfferInterpreter.startDetached(st, a)));
                    } else {
                        acts.add(a);
                    }
                }
                main.add(JSON.valueToTree(acts));
            }
            for (JsonNode group : main) {
                List<JsonNode> acts = new ArrayList<>();
                group.forEach(acts::add);
                if (acts.size() == 1) {
                    JsonNode a = acts.get(0);
                    tasks.add(task(s + "-" + id(a.get("activityId").asText()), st -> OfferInterpreter.runActivity(st, a)));
                } else if (acts.size() > 1) {
                    tasks.add(task(s + "-parallel-" + acts.size(), st -> OfferInterpreter.runParallel(st, acts)));
                }
            }
            if (!gate.isMissingNode() && !gate.isNull()) {
                JsonNode policy = gate.path("effectivePolicy");
                tasks.add(task("gate-" + s, st -> OfferInterpreter.gate(st, policy)));
            }
        }
        tasks.add(task("offer-completed", OfferInterpreter::complete));

        return FlowWorkflowBuilder.workflow(name, NAMESPACE, "1.0.0").tasks(tasks.toArray(new FuncTaskConfigurer[0])).build();
    }

    private static JsonNode read(String resource) {
        try (InputStream in = PlanFlow.class.getResourceAsStream(resource)) {
            if (in == null) throw new IllegalStateException("piano non trovato: " + resource);
            return JSON.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
