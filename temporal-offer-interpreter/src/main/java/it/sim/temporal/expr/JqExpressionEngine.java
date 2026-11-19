package it.sim.temporal.expr;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;

import net.thisptr.jackson.jq.BuiltinFunctionLoader;
import net.thisptr.jackson.jq.JsonQuery;
import net.thisptr.jackson.jq.Scope;
import net.thisptr.jackson.jq.Versions;
import net.thisptr.jackson.jq.exception.JsonQueryException;

/**
 * jq con jackson-jq, come Quarkus Flow: lo scope radice carica le funzioni built-in di jq
 * (length, map, select, to_entries, unique, @uri, ...). Ogni valutazione usa uno scope figlio con le variabili.
 * Le espressioni compilate sono immutabili e messe in cache.
 */
public final class JqExpressionEngine implements ExpressionEngine {

    private static final Scope ROOT = rootScope();
    private static final Map<String, JsonQuery> CACHE = new ConcurrentHashMap<>();

    private static Scope rootScope() {
        Scope scope = Scope.newEmptyScope();
        BuiltinFunctionLoader.getInstance().loadFunctions(Versions.JQ_1_6, scope);
        return scope;
    }

    @Override
    public void check(String expression) {
        compile(expression);
    }

    private JsonQuery compile(String expression) {
        JsonQuery cached = CACHE.get(expression);
        if (cached != null) return cached;
        try {
            JsonQuery q = JsonQuery.compile(expression, Versions.JQ_1_6);
            CACHE.put(expression, q);
            return q;
        } catch (JsonQueryException e) {
            throw new ExpressionException("espressione jq non valida: " + expression + " (" + e.getMessage() + ")", e);
        }
    }

    @Override
    public JsonNode evaluate(String expression, JsonNode input, Map<String, JsonNode> variables) {
        JsonQuery query = compile(expression);
        Scope scope = Scope.newChildScope(ROOT);
        variables.forEach((name, value) -> scope.setValue(name, (JsonNode) (value == null ? NullNode.instance : value)));
        List<JsonNode> out = new ArrayList<>();
        try {
            query.apply(scope, input == null ? NullNode.instance : input, out::add);
        } catch (JsonQueryException e) {
            throw new ExpressionException("errore valutando " + expression + ": " + e.getMessage(), e);
        }
        if (out.isEmpty()) return NullNode.instance;
        if (out.size() == 1) return out.get(0);
        return JsonNodeFactory.instance.arrayNode().addAll(out);
    }
}
