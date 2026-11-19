package it.sim.java;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.quarkus.arc.Arc;

/**
 * Semantica dell'Execution Plan scritta in Java: attività (1 chiamata per N prodotti / per prodotto, rami non attesi)
 * e gate (Solo OK, Ferma tutto, Prosegui anche con KO). Lo stato del processo è una Map che passa da un task al successivo.
 */
public final class OfferInterpreter {

    static final ObjectMapper JSON = new ObjectMapper();
    static final Pattern ESITO = Pattern.compile("^esiti\\.(\\w+)\\.(\\w+)$");
    static final Pattern PATH = Pattern.compile("^[A-Za-z_]\\w*(\\.\\w+)+$");

    /** Esiti arrivati dai rami "non attesi" dopo che il processo è proseguito: pratica/attività -> risposta. */
    public static final Map<String, JsonNode> LATE_RESULTS = new ConcurrentHashMap<>();

    private OfferInterpreter() {
    }

    static ServiceClient client() {
        return Arc.container().instance(ServiceClient.class).get();
    }

    public static Map<String, Object> init(Map<String, Object> input, List<String> products) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("input", input == null ? Map.of() : input);
        s.put("activeProducts", new ArrayList<>(products));
        s.put("koProducts", new ArrayList<String>());
        s.put("esiti", new LinkedHashMap<String, Object>());
        s.put("koByBlock", new LinkedHashMap<String, List<String>>());
        s.put("status", "RUNNING");
        return s;
    }

    /** Valore di una sorgente di input: esito di un'altra attività, percorso sull'input della pratica oppure valore fisso. */
    @SuppressWarnings("unchecked")
    static Object resolve(String source, Map<String, Object> state) {
        if (source == null || source.isBlank()) return null;
        Matcher e = ESITO.matcher(source);
        if (e.matches()) {
            Object r = ((Map<String, Object>) state.get("esiti")).get(e.group(1));
            return r instanceof Map<?, ?> m ? m.get(e.group(2)) : null;
        }
        if (PATH.matcher(source).matches()) {
            Object cur = state.get("input");
            for (String part : source.split("\\.")) {
                if (!(cur instanceof Map<?, ?> m)) return null;
                cur = m.get(part);
            }
            return cur;
        }
        return source;
    }

    @SuppressWarnings("unchecked")
    private static boolean running(Map<String, Object> state) {
        return "RUNNING".equals(state.get("status"));
    }

    @SuppressWarnings("unchecked")
    private static List<String> targets(Map<String, Object> state, JsonNode activity) {
        List<String> active = (List<String>) state.get("activeProducts");
        Map<String, List<String>> koByBlock = (Map<String, List<String>>) state.get("koByBlock");
        // esclude i prodotti andati in KO nei blocchi da cui l'attività dipende
        List<String> depKo = new ArrayList<>();
        activity.path("dependsOn").forEach(d -> depKo.addAll(koByBlock.getOrDefault(d.asText(), List.of())));
        List<String> t = new ArrayList<>();
        activity.path("products").forEach(p -> {
            if (active.contains(p.asText()) && !depKo.contains(p.asText())) t.add(p.asText());
        });
        return t;
    }

    private static List<List<String>> batches(JsonNode activity, List<String> targets) {
        List<List<String>> b = new ArrayList<>();
        if ("ONE_CALL_PER_PRODUCT".equals(activity.at("/invocation/mode").asText())) targets.forEach(t -> b.add(List.of(t)));
        else b.add(targets);
        return b;
    }

    @SuppressWarnings("unchecked")
    private static void merge(Map<String, Object> state, JsonNode activity, List<JsonNode> results) {
        List<String> ko = (List<String>) state.get("koProducts");
        Map<String, List<String>> koByBlock = (Map<String, List<String>>) state.get("koByBlock");
        List<String> blockKo = koByBlock.computeIfAbsent(activity.get("activityId").asText(), k -> new ArrayList<>());
        Map<String, Object> esiti = (Map<String, Object>) state.get("esiti");
        for (JsonNode r : results) {
            r.path("productOutcomes").fields().forEachRemaining(en -> {
                if ("KO".equals(en.getValue().asText())) {
                    if (!ko.contains(en.getKey())) ko.add(en.getKey());
                    if (!blockKo.contains(en.getKey())) blockKo.add(en.getKey());
                }
            });
        }
        Map<String, Object> last = JSON.convertValue(results.get(results.size() - 1), new TypeReference<Map<String, Object>>() {
        });
        esiti.put(activity.get("activityId").asText(), last);
        esiti.put(activity.get("taskId").asText(), last);
    }

    /** Attività attesa: tutte le chiamate (in parallelo, una per prodotto se richiesto) devono rispondere prima di proseguire. */
    public static Map<String, Object> runActivity(Map<String, Object> state, JsonNode activity) {
        if (!running(state)) return state;
        List<String> targets = targets(state, activity);
        if (targets.isEmpty()) return state;
        List<CompletableFuture<JsonNode>> calls = new ArrayList<>();
        for (List<String> batch : batches(activity, targets)) {
            calls.add(CompletableFuture.supplyAsync(() -> client().call(activity, state, batch)));
        }
        List<JsonNode> results = new ArrayList<>();
        calls.forEach(f -> results.add(f.join()));
        merge(state, activity, results);
        return state;
    }

    /** Stage con più attività in parallelo: partono tutte insieme, si prosegue quando sono tutte concluse. */
    public static Map<String, Object> runParallel(Map<String, Object> state, List<JsonNode> activities) {
        if (!running(state)) return state;
        List<CompletableFuture<List<JsonNode>>> all = new ArrayList<>();
        for (JsonNode a : activities) {
            List<String> targets = targets(state, a);
            all.add(CompletableFuture.supplyAsync(() -> {
                List<JsonNode> res = new ArrayList<>();
                List<CompletableFuture<JsonNode>> calls = new ArrayList<>();
                for (List<String> batch : batches(a, targets)) calls.add(CompletableFuture.supplyAsync(() -> client().call(a, state, batch)));
                calls.forEach(c -> res.add(c.join()));
                return res;
            }));
        }
        for (int i = 0; i < activities.size(); i++) {
            List<JsonNode> res = all.get(i).join();
            if (!res.isEmpty()) merge(state, activities.get(i), res);
        }
        return state;
    }

    /** "Non attendere": la chiamata parte e il processo prosegue subito; l'esito si registra quando arriva. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> startDetached(Map<String, Object> state, JsonNode activity) {
        if (!running(state)) return state;
        List<String> targets = targets(state, activity);
        if (targets.isEmpty()) return state;
        Map<String, Object> snapshot = new LinkedHashMap<>(state);
        Object pratica = resolve("pratica.id", state);
        for (List<String> batch : batches(activity, targets)) {
            CompletableFuture.supplyAsync(() -> client().call(activity, snapshot, batch))
                    .thenAccept(r -> LATE_RESULTS.put(pratica + "/" + activity.get("activityId").asText() + "/" + batch, r));
        }
        return state;
    }

    /** Barra regole tra due step: decide chi prosegue, o se l'offerta si ferma. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> gate(Map<String, Object> state, JsonNode policy) {
        if (!running(state)) return state;
        List<String> active = (List<String>) state.get("activeProducts");
        List<String> ko = (List<String>) state.get("koProducts");
        JsonNode stop = policy.path("stopOnKo");
        boolean stopAll = stop.isTextual() && "ALL".equals(stop.asText());
        boolean stopSome = stop.isArray() && ko.stream().anyMatch(p -> {
            for (JsonNode s : stop) if (s.asText().equals(p)) return true;
            return false;
        });
        if ((stopAll && !ko.isEmpty()) || stopSome) {
            state.put("status", "STOPPED");
            state.put("activeProducts", new ArrayList<String>());
            return state;
        }
        List<String> remaining = new ArrayList<>(active);
        if (!"CONTINUE".equals(policy.path("koProducts").asText())) remaining.removeAll(ko);
        state.put("activeProducts", remaining);
        state.put("koProducts", new ArrayList<String>());
        if (remaining.isEmpty()) state.put("status", "NO_PRODUCTS");
        return state;
    }

    public static Map<String, Object> complete(Map<String, Object> state) {
        if (running(state)) state.put("status", "COMPLETED");
        return state;
    }
}
