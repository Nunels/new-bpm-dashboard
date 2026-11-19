package it.sim.temporal.expr;

import java.util.Iterator;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Utilità sulle espressioni in modalità "strict" della specifica: una stringa è un'espressione solo se è racchiusa in ${ }. */
public final class Expressions {

    /** Funzioni jq non deterministiche: in un workflow Temporal renderebbero il replay diverso dall'esecuzione originale. */
    private static final Pattern NON_DETERMINISTIC = Pattern.compile(
            "(?<![\\w.$\"])(now|env|input|inputs|input_filename|debug|stderr)\\b(?!\\s*:)|\\$ENV\\b|\\$__loc__");

    private Expressions() {
    }

    public static boolean isExpression(JsonNode node) {
        return node != null && node.isTextual() && isExpression(node.asText());
    }

    public static boolean isExpression(String s) {
        String t = s.trim();
        return t.startsWith("${") && t.endsWith("}");
    }

    /** Corpo dell'espressione senza ${ }. */
    public static String body(String s) {
        String t = s.trim();
        return t.substring(2, t.length() - 1).trim();
    }

    /** Funzione non deterministica usata nell'espressione, o null. */
    public static String nonDeterministic(String expression) {
        var m = NON_DETERMINISTIC.matcher(expression);
        return m.find() ? m.group() : null;
    }

    /** Valuta in profondità: le stringhe ${ } diventano valori, il resto resta letterale. */
    public static JsonNode evaluateDeep(ExpressionEngine engine, JsonNode template, JsonNode input, Map<String, JsonNode> vars) {
        if (template == null || template.isNull() || template.isMissingNode()) return template;
        if (isExpression(template)) return engine.evaluate(body(template.asText()), input, vars);
        if (template.isObject()) {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            Iterator<Map.Entry<String, JsonNode>> it = template.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                out.set(e.getKey(), evaluateDeep(engine, e.getValue(), input, vars));
            }
            return out;
        }
        if (template.isArray()) {
            ArrayNode out = JsonNodeFactory.instance.arrayNode();
            template.forEach(item -> out.add(evaluateDeep(engine, item, input, vars)));
            return out;
        }
        return template;
    }

    /** Verità alla jq: false e null sono falsi, tutto il resto vero. */
    public static boolean truthy(JsonNode n) {
        return n != null && !n.isNull() && !n.isMissingNode() && !(n.isBoolean() && !n.asBoolean());
    }
}
