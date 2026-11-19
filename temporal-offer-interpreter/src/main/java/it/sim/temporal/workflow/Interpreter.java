package it.sim.temporal.workflow;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ChildWorkflowFailure;
import io.temporal.failure.TimeoutFailure;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Promise;
import io.temporal.workflow.Workflow;
import it.sim.temporal.activities.EventActivities;
import it.sim.temporal.activities.HttpActivities;
import it.sim.temporal.activities.HttpCall;
import it.sim.temporal.dsl.DefinitionValidator;
import it.sim.temporal.dsl.Durations;
import it.sim.temporal.dsl.WorkflowError;
import it.sim.temporal.expr.ExpressionEngine;
import it.sim.temporal.expr.ExpressionEngine.ExpressionException;
import it.sim.temporal.expr.Expressions;

/**
 * Esegue una definizione Serverless Workflow 1.0 dentro un workflow Temporal.
 * Gira nel thread del workflow: tutto ciò che non è deterministico passa da activity, timer, signal o child workflow,
 * così il replay di Temporal ricostruisce sempre lo stesso stato.
 *
 * Semantica (DSL 1.0, "Data Flow"): l'input trasformato di un task è l'output trasformato del precedente; export.as
 * aggiorna $context; then (continue, exit, end, nome task) decide il task successivo.
 */
final class Interpreter {

    static final Duration DEFAULT_CALL_TIMEOUT = Duration.ofMinutes(5);
    private static final JsonNodeFactory F = JsonNodeFactory.instance;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, JsonSchema> SCHEMAS = new ConcurrentHashMap<>();

    private final ExpressionEngine jq;
    private final List<JsonNode> events;
    private JsonNode context = NullNode.instance;
    private ObjectNode workflowDescriptor;
    private final ObjectNode runtimeDescriptor = F.objectNode().put("name", "temporal-offer-interpreter").put("version", "1.0.0");
    private String currentTask = "";
    private int childSeq;

    Interpreter(ExpressionEngine jq, List<JsonNode> events) {
        this.jq = jq;
        this.events = events;
    }

    JsonNode context() {
        return context;
    }

    String currentTask() {
        return currentTask;
    }

    /* ---------------- flusso ---------------- */

    private enum Directive { CONTINUE, EXIT, END, GOTO }

    private record Flow(Directive directive, String target) {
        static final Flow CONTINUE = new Flow(Directive.CONTINUE, null);
        static final Flow EXIT = new Flow(Directive.EXIT, null);
        static final Flow END = new Flow(Directive.END, null);

        static Flow of(String then) {
            return switch (then) {
                case "continue" -> CONTINUE;
                case "exit" -> EXIT;
                case "end" -> END;
                default -> new Flow(Directive.GOTO, then);
            };
        }
    }

    private record Result(JsonNode output, Flow flow) {
    }

    /** Variabili delle espressioni oltre a $context, $workflow, $runtime, $secrets: $task, $input, variabili di ciclo, $error. */
    private record Frame(Map<String, JsonNode> vars) {
        static final Frame EMPTY = new Frame(Map.of());

        Frame with(String name, JsonNode value) {
            Map<String, JsonNode> m = new LinkedHashMap<>(vars);
            m.put(name, value);
            return new Frame(Collections.unmodifiableMap(m));
        }
    }

    RunResult execute(JsonNode definition, JsonNode rawInput, String ref) {
        long started = Workflow.currentTimeMillis();
        workflowDescriptor = F.objectNode();
        workflowDescriptor.put("id", Workflow.getInfo().getWorkflowId());
        workflowDescriptor.set("definition", definition);
        workflowDescriptor.set("input", rawInput);
        ObjectNode startedAt = workflowDescriptor.putObject("startedAt");
        startedAt.put("iso8601", Instant.ofEpochMilli(started).toString());
        startedAt.putObject("epoch").put("seconds", started / 1000).put("milliseconds", started);
        try {
            validateInput(definition.path("input").path("schema"), rawInput);
            JsonNode input = definition.path("input").has("from") ? eval(definition.get("input").get("from"), rawInput, Frame.EMPTY, null, "/input/from") : rawInput;
            context = input;
            Result r = executeList(definition.get("do"), "/do", input, Frame.EMPTY);
            if (r.flow().directive() == Directive.GOTO) {
                throw WorkflowError.of(WorkflowError.RUNTIME, 500, "Destinazione di then inesistente", r.flow().target(), "/do");
            }
            JsonNode out = r.output();
            if (definition.path("output").has("as")) out = eval(definition.get("output").get("as"), out, Frame.EMPTY, null, "/output/as");
            return RunResult.completed(ref, out.toString());
        } catch (WorkflowError e) {
            return RunResult.faulted(ref, e.json().toString());
        }
    }

    private void validateInput(JsonNode schema, JsonNode input) {
        if (!schema.path("document").isObject()) return;
        String key = schema.get("document").toString();
        JsonSchema s = SCHEMAS.computeIfAbsent(key, k -> JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(schema.get("document")));
        Set<ValidationMessage> msgs = s.validate(input);
        if (!msgs.isEmpty()) {
            TreeSet<String> sorted = new TreeSet<>();
            msgs.forEach(m -> sorted.add(m.getMessage()));
            throw WorkflowError.of(WorkflowError.VALIDATION, 400, "Input del workflow non valido", String.join("; ", sorted), "/input");
        }
    }

    private Result executeList(JsonNode tasks, String ref, JsonNode input, Frame frame) {
        JsonNode current = input;
        int i = 0;
        while (i < tasks.size()) {
            Map.Entry<String, JsonNode> e = tasks.get(i).fields().next();
            Result r = executeTask(e.getKey(), e.getValue(), ref + "/" + i + "/" + e.getKey(), current, frame);
            current = r.output();
            switch (r.flow().directive()) {
                case CONTINUE -> i++;
                case EXIT -> {
                    return new Result(current, Flow.CONTINUE);
                }
                case END -> {
                    return r;
                }
                case GOTO -> {
                    int j = indexOf(tasks, r.flow().target());
                    if (j < 0) return r; // risale alla lista che contiene la destinazione
                    i = j;
                }
                default -> throw new IllegalStateException();
            }
        }
        return new Result(current, Flow.CONTINUE);
    }

    private static int indexOf(JsonNode tasks, String name) {
        for (int i = 0; i < tasks.size(); i++) if (tasks.get(i).has(name)) return i;
        return -1;
    }

    private Result executeTask(String name, JsonNode task, String ref, JsonNode rawInput, Frame frame) {
        currentTask = ref;
        ObjectNode descriptor = F.objectNode().put("name", name).put("reference", ref);
        descriptor.set("definition", task);
        Frame f = frame.with("task", descriptor).with("input", rawInput);
        if (task.has("if") && !Expressions.truthy(eval(task.get("if"), rawInput, f, null, ref + "/if"))) {
            return new Result(rawInput, Flow.CONTINUE);
        }
        JsonNode in = task.path("input").has("from") ? eval(task.get("input").get("from"), rawInput, f, null, ref + "/input/from") : rawInput;
        f = f.with("input", in);

        String type = DefinitionValidator.typeOf(task);
        Flow flow = Flow.CONTINUE;
        JsonNode out;
        switch (type) {
            case "set" -> out = eval(task.get("set"), in, f, null, ref + "/set");
            case "do" -> {
                Result r = executeList(task.get("do"), ref + "/do", in, f);
                if (r.flow().directive() != Directive.CONTINUE) return r;
                out = r.output();
            }
            case "call" -> out = call(task, ref, in, f);
            case "try" -> {
                Result r = tryTask(task, ref, in, f);
                if (r.flow().directive() != Directive.CONTINUE) return r;
                out = r.output();
            }
            case "for" -> {
                Result r = forTask(task, ref, in, f);
                if (r.flow().directive() != Directive.CONTINUE) return r;
                out = r.output();
            }
            case "fork" -> out = fork(task, ref, in, f);
            case "switch" -> {
                flow = switchTask(task, ref, in, f);
                out = in;
            }
            case "raise" -> throw WorkflowError.fromDefinition(eval(task.get("raise").get("error"), in, f, null, ref + "/raise/error"), ref);
            case "run" -> out = run(task, ref, in, f);
            case "listen" -> out = listen(task, ref, in, f);
            case "emit" -> {
                emit(task, ref, in, f);
                out = in;
            }
            case "wait" -> {
                Workflow.sleep(Durations.parse(task.get("wait")));
                out = in;
            }
            default -> throw WorkflowError.of(WorkflowError.RUNTIME, 500, "Tipo di task non supportato", type, ref);
        }
        if (task.path("output").has("as")) out = eval(task.get("output").get("as"), out, f, null, ref + "/output/as");
        if (task.path("export").has("as")) context = eval(task.get("export").get("as"), out, f, out, ref + "/export/as");
        if (flow.directive() == Directive.CONTINUE && task.has("then")) flow = Flow.of(task.get("then").asText());
        return new Result(out, flow);
    }

    /* ---------------- task ---------------- */

    private JsonNode call(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode with = task.get("with");
        String method = eval(with.get("method"), in, f, null, ref + "/with/method").asText().toUpperCase();
        JsonNode ep = with.get("endpoint");
        String uri = eval(ep.isObject() ? ep.get("uri") : ep, in, f, null, ref + "/with/endpoint").asText();
        HttpCall.Request req = new HttpCall.Request();
        req.method = method;
        req.uri = uri;
        if (with.has("headers")) toStrings(eval(with.get("headers"), in, f, null, ref + "/with/headers"), req.headers);
        if (with.has("query")) toStrings(eval(with.get("query"), in, f, null, ref + "/with/query"), req.query);
        if (with.has("body")) req.bodyJson = eval(with.get("body"), in, f, null, ref + "/with/body").toString();
        Duration timeout = task.has("timeout") ? Durations.parse(task.get("timeout").get("after")) : DEFAULT_CALL_TIMEOUT;
        // i retry li decide il workflow (try/catch): l'activity fa un solo tentativo
        HttpActivities http = Workflow.newActivityStub(HttpActivities.class, ActivityOptions.newBuilder()
                .setStartToCloseTimeout(timeout).setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(1).build()).build());
        HttpCall.Response resp;
        try {
            resp = http.call(req);
        } catch (ActivityFailure e) {
            boolean timedOut = e.getCause() instanceof TimeoutFailure;
            throw WorkflowError.of(timedOut ? WorkflowError.TIMEOUT : WorkflowError.COMMUNICATION, timedOut ? 408 : 503,
                    timedOut ? "Timeout della chiamata" : "Servizio non raggiungibile", method + " " + uri + ": " + rootMessage(e), ref);
        }
        if (resp.status >= 400) {
            throw WorkflowError.of(WorkflowError.COMMUNICATION, resp.status, "Risposta HTTP " + resp.status, method + " " + uri + ": " + resp.bodyJson, ref);
        }
        JsonNode content = parse(resp.bodyJson);
        if (!"response".equals(with.path("output").asText("content"))) return content;
        ObjectNode full = F.objectNode();
        full.putObject("request").put("method", method).put("uri", uri);
        full.put("statusCode", resp.status);
        ObjectNode headers = full.putObject("headers");
        resp.headers.forEach(headers::put);
        full.set("content", content);
        return full;
    }

    private Result tryTask(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode c = task.get("catch");
        JsonNode retry = c.get("retry");
        int limit = retry == null ? 0 : retry.path("limit").path("attempt").path("count").asInt(Integer.MAX_VALUE);
        int attempt = 0;
        while (true) {
            try {
                return executeList(task.get("try"), ref + "/try", in, f);
            } catch (WorkflowError err) {
                String as = c.path("as").asText("error");
                Frame fe = f.with(as, err.json());
                if (!catches(c, err, in, fe, ref)) throw err;
                if (retry != null && attempt < limit) {
                    Workflow.sleep(delay(retry, attempt));
                    attempt++;
                    continue;
                }
                if (c.has("do")) return executeList(c.get("do"), ref + "/catch/do", in, fe);
                // retry esauriti senza catch.do: l'errore si propaga (la specifica non lo definisce; scelta documentata)
                if (retry != null) throw err;
                return new Result(in, Flow.CONTINUE);
            }
        }
    }

    private boolean catches(JsonNode c, WorkflowError err, JsonNode in, Frame f, String ref) {
        JsonNode filter = c.path("errors").path("with");
        ObjectNode e = err.json();
        var it = filter.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> kv = it.next();
            if (!sameValue(e.get(kv.getKey()), kv.getValue())) return false;
        }
        if (c.has("when") && !Expressions.truthy(eval(c.get("when"), in, f, null, ref + "/catch/when"))) return false;
        return !(c.has("exceptWhen") && Expressions.truthy(eval(c.get("exceptWhen"), in, f, null, ref + "/catch/exceptWhen")));
    }

    private static Duration delay(JsonNode retry, int attempt) {
        Duration base = retry.has("delay") ? Durations.parse(retry.get("delay")) : Duration.ZERO;
        JsonNode backoff = retry.path("backoff");
        if (backoff.has("exponential")) return base.multipliedBy(1L << Math.min(attempt, 30));
        if (backoff.has("linear")) return base.multipliedBy(attempt + 1L);
        return base;
    }

    private Result forTask(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode def = task.get("for");
        String each = def.path("each").asText("item");
        String at = def.path("at").asText("index");
        JsonNode items = eval(def.get("in"), in, f, null, ref + "/for/in");
        if (items == null || items.isNull()) items = F.arrayNode();
        if (!items.isArray()) throw WorkflowError.of(WorkflowError.EXPRESSION, 400, "for.in deve restituire un array", items.toString(), ref + "/for/in");
        JsonNode current = in;
        for (int i = 0; i < items.size(); i++) {
            Frame fi = f.with(each, items.get(i)).with(at, F.numberNode(i));
            if (task.has("while") && !Expressions.truthy(eval(task.get("while"), current, fi, null, ref + "/while"))) break;
            Result r = executeList(task.get("do"), ref + "/do", current, fi);
            current = r.output();
            if (r.flow().directive() != Directive.CONTINUE) return r;
        }
        return new Result(current, Flow.CONTINUE);
    }

    /** Rami concorrenti come thread del workflow Temporal: deterministici, e le export sul contesto non si sovrappongono. */
    private JsonNode fork(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode branches = task.get("fork").get("branches");
        List<Promise<Result>> running = new ArrayList<>();
        for (int i = 0; i < branches.size(); i++) {
            Map.Entry<String, JsonNode> b = branches.get(i).fields().next();
            String bref = ref + "/fork/branches/" + i + "/" + b.getKey();
            running.add(Async.function(() -> executeTask(b.getKey(), b.getValue(), bref, in, f)));
        }
        ArrayNode outputs = F.arrayNode();
        WorkflowError first = null;
        for (Promise<Result> p : running) {
            try {
                outputs.add(p.get().output());
            } catch (WorkflowError e) {
                if (first == null) first = e;
            }
        }
        if (first != null) throw first;
        return outputs;
    }

    private Flow switchTask(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode cases = task.get("switch");
        for (int i = 0; i < cases.size(); i++) {
            Map.Entry<String, JsonNode> c = cases.get(i).fields().next();
            JsonNode when = c.getValue().get("when");
            if (when == null || Expressions.truthy(eval(when, in, f, null, ref + "/switch/" + i + "/" + c.getKey() + "/when"))) {
                return Flow.of(c.getValue().get("then").asText());
            }
        }
        return Flow.CONTINUE;
    }

    /** run: workflow come child workflow Temporal. await: false = il figlio continua da solo (ParentClosePolicy ABANDON). */
    private JsonNode run(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode r = task.get("run");
        JsonNode w = r.get("workflow");
        boolean await = r.path("await").asBoolean(true);
        String ns = eval(w.get("namespace"), in, f, null, ref + "/run/workflow/namespace").asText();
        String name = eval(w.get("name"), in, f, null, ref + "/run/workflow/name").asText();
        String version = w.has("version") ? eval(w.get("version"), in, f, null, ref + "/run/workflow/version").asText() : null;
        JsonNode childInput = w.has("input") ? eval(w.get("input"), in, f, null, ref + "/run/workflow/input") : in;
        ChildWorkflowOptions options = ChildWorkflowOptions.newBuilder()
                .setWorkflowId(Workflow.getInfo().getWorkflowId() + "/" + (++childSeq) + "-" + name)
                .setParentClosePolicy(await ? ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE : ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON)
                .build();
        OfferInterpreterWorkflow child = Workflow.newChildWorkflowStub(OfferInterpreterWorkflow.class, options);
        RunRequest request = new RunRequest(ns, name, version, childInput.toString());
        if (!await) {
            Async.function(child::run, request);
            Workflow.getWorkflowExecution(child).get(); // il figlio deve essere partito prima di proseguire
            return in;
        }
        RunResult result;
        try {
            result = child.run(request);
        } catch (ChildWorkflowFailure e) {
            throw WorkflowError.of(WorkflowError.RUNTIME, 500, "Sotto-workflow fallito", request.ref() + ": " + rootMessage(e), ref);
        }
        if ("FAULTED".equals(result.status)) throw new WorkflowError((ObjectNode) parse(result.errorJson));
        return parse(result.outputJson);
    }

    /**
     * listen: attende (senza occupare il worker) il primo evento in coda che rispetta filtro e correlazione.
     * Output come da specifica: array degli eventi consumati.
     */
    private JsonNode listen(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode l = task.get("listen");
        JsonNode one = l.get("to").get("one");
        String read = l.path("read").asText("data");
        Supplier<Integer> find = () -> {
            for (int i = 0; i < events.size(); i++) if (matches(one, events.get(i), in, f, ref)) return i;
            return -1;
        };
        if (task.has("timeout")) {
            Duration timeout = Durations.parse(task.get("timeout").get("after"));
            if (!Workflow.await(timeout, () -> find.get() >= 0)) {
                throw WorkflowError.of(WorkflowError.TIMEOUT, 408, "Evento non ricevuto entro il timeout", one.path("with").toString(), ref);
            }
        } else {
            Workflow.await(() -> find.get() >= 0);
        }
        JsonNode event = events.remove((int) find.get());
        JsonNode item = "envelope".equals(read) ? event : event.path("data");
        return F.arrayNode().add(item.isMissingNode() ? NullNode.instance : item);
    }

    private boolean matches(JsonNode one, JsonNode event, JsonNode in, Frame f, String ref) {
        try {
            var filter = one.path("with").fields();
            while (filter.hasNext()) {
                Map.Entry<String, JsonNode> kv = filter.next();
                JsonNode expected = Expressions.isExpression(kv.getValue()) ? eval(kv.getValue(), in, f, null, ref) : kv.getValue();
                if (!sameValue(event.get(kv.getKey()), expected)) return false;
            }
            var correlate = one.path("correlate").fields();
            while (correlate.hasNext()) {
                JsonNode c = correlate.next().getValue();
                JsonNode actual = eval(c.get("from"), event, f, null, ref);
                if (c.has("expect")) {
                    JsonNode expected = Expressions.isExpression(c.get("expect")) ? eval(c.get("expect"), in, f, null, ref) : c.get("expect");
                    if (!sameValue(actual, expected)) return false;
                }
            }
            return true;
        } catch (WorkflowError e) {
            return false; // evento che non si riesce a correlare: lo lascio in coda
        }
    }

    private void emit(JsonNode task, String ref, JsonNode in, Frame f) {
        JsonNode with = eval(task.get("emit").get("event").get("with"), in, f, null, ref + "/emit/event/with");
        ObjectNode event = ((ObjectNode) with).deepCopy();
        if (!event.has("id")) event.put("id", Workflow.randomUUID().toString());
        if (!event.has("specversion")) event.put("specversion", "1.0");
        if (!event.has("time")) event.put("time", Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString());
        if (event.has("data") && !event.has("datacontenttype")) event.put("datacontenttype", "application/json");
        EventActivities publisher = Workflow.newActivityStub(EventActivities.class, ActivityOptions.newBuilder()
                .setStartToCloseTimeout(Duration.ofSeconds(30))
                .setRetryOptions(RetryOptions.newBuilder().setInitialInterval(Duration.ofSeconds(1)).setMaximumAttempts(10).build()).build());
        try {
            publisher.emit(event.toString());
        } catch (ActivityFailure e) {
            throw WorkflowError.of(WorkflowError.COMMUNICATION, 503, "Pubblicazione evento fallita", rootMessage(e), ref);
        }
    }

    /* ---------------- utilità ---------------- */

    private Map<String, JsonNode> vars(Frame f, JsonNode output) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        m.put("workflow", workflowDescriptor);
        m.put("runtime", runtimeDescriptor);
        m.put("secrets", F.objectNode());
        m.put("context", context);
        m.putAll(f.vars());
        if (output != null) m.put("output", output);
        return m;
    }

    private JsonNode eval(JsonNode template, JsonNode dot, Frame f, JsonNode output, String ref) {
        try {
            JsonNode v = Expressions.evaluateDeep(jq, template, dot, vars(f, output));
            return v == null ? NullNode.instance : v;
        } catch (ExpressionException e) {
            throw WorkflowError.of(WorkflowError.EXPRESSION, 400, "Errore nell'espressione", e.getMessage(), ref);
        }
    }

    private static void toStrings(JsonNode obj, Map<String, String> target) {
        obj.fields().forEachRemaining(e -> {
            if (!e.getValue().isNull()) target.put(e.getKey(), e.getValue().isValueNode() ? e.getValue().asText() : e.getValue().toString());
        });
    }

    private static boolean sameValue(JsonNode a, JsonNode b) {
        if (a == null || b == null || a.isNull() || b.isNull()) return (a == null || a.isNull()) && (b == null || b.isNull());
        return a.equals(b) || (a.isValueNode() && b.isValueNode() && a.asText().equals(b.asText()));
    }

    static JsonNode parse(String json) {
        if (json == null) return NullNode.instance;
        try {
            return JSON.readTree(json);
        } catch (IOException e) {
            throw WorkflowError.of(WorkflowError.RUNTIME, 500, "JSON non valido", e.getMessage(), null);
        }
    }

    private static String rootMessage(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        return c.getMessage();
    }
}
