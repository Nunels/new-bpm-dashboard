package it.sim.temporal.dsl;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;

import it.sim.temporal.expr.ExpressionEngine;
import it.sim.temporal.expr.Expressions;

/**
 * Controlla che una definizione Serverless Workflow usi solo il perimetro di costrutti eseguito dall'interprete.
 * Tutto ciò che è fuori perimetro viene segnalato con il suo percorso (JSON Pointer), insieme alle espressioni
 * jq non compilabili o non deterministiche.
 */
public final class DefinitionValidator {

    /** Tipi di task supportati, nell'ordine con cui vengono riconosciuti (for/try hanno anche la chiave "do"). */
    public static final List<String> TYPES = List.of("for", "try", "fork", "switch", "call", "set", "raise", "run", "listen", "emit", "wait", "do");

    private static final Set<String> COMMON = Set.of("if", "input", "output", "export", "then", "metadata", "timeout");
    private static final Map<String, Set<String>> TYPE_KEYS = Map.ofEntries(
            Map.entry("do", Set.of("do")),
            Map.entry("set", Set.of("set")),
            Map.entry("call", Set.of("call", "with")),
            Map.entry("try", Set.of("try", "catch")),
            Map.entry("for", Set.of("for", "while", "do")),
            Map.entry("fork", Set.of("fork")),
            Map.entry("switch", Set.of("switch")),
            Map.entry("raise", Set.of("raise")),
            Map.entry("run", Set.of("run")),
            Map.entry("listen", Set.of("listen")),
            Map.entry("emit", Set.of("emit")),
            Map.entry("wait", Set.of("wait")));
    private static final Set<String> HTTP_METHODS = Set.of("get", "post", "put", "patch", "delete", "head", "options");

    private final ExpressionEngine engine;
    private final List<String> problems = new ArrayList<>();

    private DefinitionValidator(ExpressionEngine engine) {
        this.engine = engine;
    }

    /** Problemi trovati (lista vuota = definizione eseguibile). */
    public static List<String> validate(JsonNode definition, ExpressionEngine engine) {
        DefinitionValidator v = new DefinitionValidator(engine);
        v.root(definition);
        return v.problems;
    }

    /** Tipo del task (una delle {@link #TYPES}) o null se non riconosciuto. */
    public static String typeOf(JsonNode task) {
        for (String t : TYPES) if (task.has(t)) return t;
        return null;
    }

    private void problem(String path, String message) {
        problems.add((path.isEmpty() ? "/" : path) + ": " + message);
    }

    private void root(JsonNode def) {
        if (def == null || !def.isObject()) {
            problem("", "la definizione deve essere un oggetto");
            return;
        }
        keys(def, Set.of("document", "input", "do", "output", "evaluate"), "");
        JsonNode doc = def.path("document");
        for (String k : List.of("dsl", "namespace", "name", "version")) {
            if (!doc.path(k).isTextual()) problem("/document/" + k, "obbligatorio");
        }
        if (doc.path("dsl").isTextual() && !doc.get("dsl").asText().startsWith("1.0")) problem("/document/dsl", "supportata solo la versione 1.0.x");
        if (def.has("input")) {
            JsonNode in = def.get("input");
            keys(in, Set.of("schema", "from"), "/input");
            if (in.has("schema")) {
                JsonNode s = in.get("schema");
                keys(s, Set.of("format", "document"), "/input/schema");
                if (s.has("format") && !"json".equals(s.get("format").asText())) problem("/input/schema/format", "supportato solo json");
                if (!s.path("document").isObject()) problem("/input/schema/document", "serve uno schema inline (resource non supportato)");
            }
        }
        if (def.has("output")) keys(def.get("output"), Set.of("as"), "/output");
        if (def.has("evaluate")) {
            JsonNode ev = def.get("evaluate");
            keys(ev, Set.of("language", "mode"), "/evaluate");
            if (ev.has("language") && !"jq".equals(ev.get("language").asText())) problem("/evaluate/language", "supportato solo jq");
            if (ev.has("mode") && !"strict".equals(ev.get("mode").asText())) problem("/evaluate/mode", "supportata solo la modalità strict");
        }
        list(def.get("do"), "/do");
        expressions(def, "");
    }

    private void list(JsonNode tasks, String path) {
        if (tasks == null || !tasks.isArray()) {
            problem(path, "attesa una lista di task");
            return;
        }
        Set<String> names = new LinkedHashSet<>();
        for (JsonNode item : tasks) {
            if (item.isObject() && item.size() == 1) {
                String name = item.fieldNames().next();
                if (!names.add(name)) problem(path, "nome di task duplicato: " + name);
            }
        }
        for (int i = 0; i < tasks.size(); i++) {
            JsonNode item = tasks.get(i);
            if (!item.isObject() || item.size() != 1) {
                problem(path + "/" + i, "ogni elemento deve avere esattamente un task (- nome: {...})");
                continue;
            }
            Map.Entry<String, JsonNode> e = item.fields().next();
            task(e.getValue(), path + "/" + i + "/" + e.getKey(), names);
        }
    }

    private void task(JsonNode task, String path, Set<String> siblings) {
        if (!task.isObject()) {
            problem(path, "il task deve essere un oggetto");
            return;
        }
        String type = typeOf(task);
        if (type == null) {
            problem(path, "tipo di task non riconosciuto (supportati: " + String.join(", ", TYPES) + ")");
            return;
        }
        Set<String> allowed = new HashSet<>(COMMON);
        allowed.addAll(TYPE_KEYS.get(type));
        keys(task, allowed, path);
        if (task.has("then")) flow(task.get("then"), path + "/then", siblings);
        if (task.has("input")) keys(task.get("input"), Set.of("from"), path + "/input");
        if (task.has("output")) keys(task.get("output"), Set.of("as"), path + "/output");
        if (task.has("export")) keys(task.get("export"), Set.of("as"), path + "/export");
        if (task.has("timeout")) {
            if (!type.equals("call") && !type.equals("listen")) problem(path + "/timeout", "supportato solo su call e listen");
            JsonNode t = task.get("timeout");
            if (!t.isObject()) problem(path + "/timeout", "serve un oggetto { after: durata } (riferimenti non supportati)");
            else {
                keys(t, Set.of("after"), path + "/timeout");
                if (!Durations.isValid(t.get("after"))) problem(path + "/timeout/after", "durata non valida");
            }
        }
        switch (type) {
            case "do" -> list(task.get("do"), path + "/do");
            case "set" -> {
                JsonNode s = task.get("set");
                if (!s.isObject() && !Expressions.isExpression(s)) problem(path + "/set", "atteso un oggetto o un'espressione");
            }
            case "call" -> call(task, path);
            case "try" -> tryTask(task, path);
            case "for" -> forTask(task, path);
            case "fork" -> fork(task, path);
            case "switch" -> switchTask(task, path, siblings);
            case "raise" -> raise(task, path);
            case "run" -> run(task, path);
            case "listen" -> listen(task, path);
            case "emit" -> emit(task, path);
            case "wait" -> {
                if (!Durations.isValid(task.get("wait"))) problem(path + "/wait", "durata non valida");
            }
            default -> problem(path, "tipo non gestito: " + type);
        }
    }

    private void call(JsonNode task, String path) {
        String fn = task.path("call").asText();
        if (!"http".equals(fn)) {
            problem(path + "/call", "supportato solo call: http (trovato: " + fn + ")");
            return;
        }
        JsonNode with = task.path("with");
        if (!with.isObject()) {
            problem(path + "/with", "obbligatorio");
            return;
        }
        keys(with, Set.of("method", "endpoint", "headers", "body", "query", "output"), path + "/with");
        JsonNode m = with.path("method");
        if (!m.isTextual()) problem(path + "/with/method", "obbligatorio");
        else if (!Expressions.isExpression(m) && !HTTP_METHODS.contains(m.asText().toLowerCase())) problem(path + "/with/method", "metodo HTTP non valido: " + m.asText());
        JsonNode ep = with.path("endpoint");
        if (ep.isObject()) {
            keys(ep, Set.of("uri"), path + "/with/endpoint");
            if (!ep.path("uri").isTextual()) problem(path + "/with/endpoint/uri", "obbligatorio");
        } else if (!ep.isTextual()) problem(path + "/with/endpoint", "obbligatorio");
        if (with.has("output") && !Set.of("content", "response").contains(with.get("output").asText())) problem(path + "/with/output", "supportati content e response");
        for (String k : List.of("headers", "query")) {
            if (with.has(k) && !with.get(k).isObject() && !Expressions.isExpression(with.get(k))) problem(path + "/with/" + k, "atteso un oggetto");
        }
    }

    private void tryTask(JsonNode task, String path) {
        list(task.get("try"), path + "/try");
        JsonNode c = task.path("catch");
        if (!c.isObject()) {
            problem(path + "/catch", "obbligatorio");
            return;
        }
        keys(c, Set.of("errors", "as", "when", "exceptWhen", "retry", "do"), path + "/catch");
        if (c.has("errors")) {
            keys(c.get("errors"), Set.of("with"), path + "/catch/errors");
            if (c.get("errors").has("with")) keys(c.get("errors").get("with"), Set.of("type", "status", "instance", "title", "details"), path + "/catch/errors/with");
        }
        if (c.has("retry")) {
            JsonNode r = c.get("retry");
            if (!r.isObject()) problem(path + "/catch/retry", "serve una policy inline (riferimenti a use.retries non supportati)");
            else {
                keys(r, Set.of("delay", "backoff", "limit"), path + "/catch/retry");
                if (r.has("delay") && !Durations.isValid(r.get("delay"))) problem(path + "/catch/retry/delay", "durata non valida");
                if (r.has("backoff")) {
                    keys(r.get("backoff"), Set.of("constant", "linear", "exponential"), path + "/catch/retry/backoff");
                    if (r.get("backoff").size() != 1) problem(path + "/catch/retry/backoff", "indicare una sola strategia");
                }
                if (r.has("limit")) {
                    keys(r.get("limit"), Set.of("attempt"), path + "/catch/retry/limit");
                    JsonNode a = r.get("limit").path("attempt");
                    if (a.isObject()) {
                        keys(a, Set.of("count"), path + "/catch/retry/limit/attempt");
                        if (!a.path("count").canConvertToInt()) problem(path + "/catch/retry/limit/attempt/count", "intero obbligatorio");
                    }
                }
            }
        }
        if (c.has("do")) list(c.get("do"), path + "/catch/do");
    }

    private void forTask(JsonNode task, String path) {
        JsonNode f = task.path("for");
        keys(f, Set.of("each", "in", "at"), path + "/for");
        if (!Expressions.isExpression(f.path("in"))) problem(path + "/for/in", "obbligatoria un'espressione");
        list(task.get("do"), path + "/do");
    }

    private void fork(JsonNode task, String path) {
        JsonNode f = task.path("fork");
        keys(f, Set.of("branches", "compete"), path + "/fork");
        if (f.path("compete").asBoolean(false)) problem(path + "/fork/compete", "compete: true non supportato");
        list(f.get("branches"), path + "/fork/branches");
    }

    private void switchTask(JsonNode task, String path, Set<String> siblings) {
        JsonNode cases = task.path("switch");
        if (!cases.isArray()) {
            problem(path + "/switch", "attesa una lista di casi");
            return;
        }
        for (int i = 0; i < cases.size(); i++) {
            JsonNode item = cases.get(i);
            String p = path + "/switch/" + i;
            if (!item.isObject() || item.size() != 1) {
                problem(p, "ogni caso deve avere un nome");
                continue;
            }
            Map.Entry<String, JsonNode> e = item.fields().next();
            keys(e.getValue(), Set.of("when", "then"), p + "/" + e.getKey());
            if (!e.getValue().has("then")) problem(p + "/" + e.getKey() + "/then", "obbligatorio");
            else flow(e.getValue().get("then"), p + "/" + e.getKey() + "/then", siblings);
        }
    }

    private void raise(JsonNode task, String path) {
        JsonNode err = task.path("raise").path("error");
        keys(task.get("raise"), Set.of("error"), path + "/raise");
        if (!err.isObject()) {
            problem(path + "/raise/error", "serve un errore inline (riferimenti a use.errors non supportati)");
            return;
        }
        keys(err, Set.of("type", "status", "title", "detail", "instance"), path + "/raise/error");
        if (!err.has("type")) problem(path + "/raise/error/type", "obbligatorio");
        if (!err.has("status")) problem(path + "/raise/error/status", "obbligatorio");
    }

    private void run(JsonNode task, String path) {
        JsonNode r = task.path("run");
        keys(r, Set.of("workflow", "await"), path + "/run");
        JsonNode w = r.path("workflow");
        if (!w.isObject()) {
            problem(path + "/run", "supportato solo run: workflow (container, script e shell no)");
            return;
        }
        keys(w, Set.of("namespace", "name", "version", "input"), path + "/run/workflow");
        if (!w.path("namespace").isTextual()) problem(path + "/run/workflow/namespace", "obbligatorio");
        if (!w.path("name").isTextual()) problem(path + "/run/workflow/name", "obbligatorio");
    }

    private void listen(JsonNode task, String path) {
        JsonNode l = task.path("listen");
        keys(l, Set.of("to", "read"), path + "/listen");
        if (l.has("read") && !Set.of("data", "envelope").contains(l.get("read").asText())) problem(path + "/listen/read", "supportati data ed envelope");
        JsonNode to = l.path("to");
        keys(to, Set.of("one"), path + "/listen/to");
        JsonNode one = to.path("one");
        if (!one.isObject()) {
            problem(path + "/listen/to", "supportato solo to.one (any, all e until no)");
            return;
        }
        keys(one, Set.of("with", "correlate"), path + "/listen/to/one");
        if (!one.path("with").isObject()) problem(path + "/listen/to/one/with", "obbligatorio");
        else if (one.get("with").has("data")) problem(path + "/listen/to/one/with/data", "filtro sui dati non supportato: usare correlate");
        if (one.has("correlate")) {
            Iterator<Map.Entry<String, JsonNode>> it = one.get("correlate").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                String p = path + "/listen/to/one/correlate/" + e.getKey();
                keys(e.getValue(), Set.of("from", "expect"), p);
                if (!Expressions.isExpression(e.getValue().path("from"))) problem(p + "/from", "obbligatoria un'espressione");
            }
        }
    }

    private void emit(JsonNode task, String path) {
        JsonNode e = task.path("emit");
        keys(e, Set.of("event"), path + "/emit");
        keys(e.path("event"), Set.of("with"), path + "/emit/event");
        JsonNode w = e.path("event").path("with");
        if (!w.isObject()) problem(path + "/emit/event/with", "obbligatorio");
        else for (String k : List.of("type", "source")) if (!w.has(k)) problem(path + "/emit/event/with/" + k, "obbligatorio");
    }

    private void flow(JsonNode then, String path, Set<String> siblings) {
        String t = then.asText();
        if (!then.isTextual() || (!Set.of("continue", "exit", "end").contains(t) && !siblings.contains(t))) {
            problem(path, "deve essere continue, exit, end o il nome di un task della stessa lista (trovato: " + then + ")");
        }
    }

    private void keys(JsonNode obj, Set<String> allowed, String path) {
        if (obj == null || !obj.isObject()) {
            problem(path, "atteso un oggetto");
            return;
        }
        obj.fieldNames().forEachRemaining(k -> {
            if (!allowed.contains(k)) problem(path + "/" + k, "non supportato");
        });
    }

    /** Ogni stringa ${ } (esclusi document e metadata) deve compilare e non usare funzioni non deterministiche. */
    private void expressions(JsonNode n, String path) {
        if (Expressions.isExpression(n)) {
            String body = Expressions.body(n.asText());
            try {
                engine.check(body);
            } catch (RuntimeException e) {
                problem(path, e.getMessage());
            }
            String nd = Expressions.nonDeterministic(body);
            if (nd != null) problem(path, "funzione non deterministica non ammessa: " + nd);
        } else if (n.isObject()) {
            n.fields().forEachRemaining(e -> {
                if (!e.getKey().equals("document") && !e.getKey().equals("metadata")) expressions(e.getValue(), path + "/" + e.getKey());
            });
        } else if (n.isArray()) {
            for (int i = 0; i < n.size(); i++) expressions(n.get(i), path + "/" + i);
        }
    }
}
