package it.sim.agent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import io.quarkus.test.common.QuarkusTestResourceLifecycleManager;

/**
 * Finto Gemini con il formato di richiesta e risposta dell'API "interactions". Risponde in base al nome del file
 * di specifiche presente nel prompt: per le specifiche del set di valutazione restituisce l'offerta attesa
 * (src/test/resources/specs/*.expected.json); alcuni nomi simulano errori.
 */
public class FakeGemini implements QuarkusTestResourceLifecycleManager {

    record Request(Map<String, String> headers, JsonNode body) {
    }

    static final List<Request> REQUESTS = new CopyOnWriteArrayList<>();
    static final Map<String, AtomicInteger> CALLS = new ConcurrentHashMap<>();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern FILE = Pattern.compile("SPECIFICA \\(file: ([^)]+)\\)");
    private HttpServer server;

    @Override
    public Map<String, String> start() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        server.createContext("/v1beta/interactions", this::handle);
        server.start();
        return Map.of("agent.gemini.base-url", "http://127.0.0.1:" + server.getAddress().getPort(),
                "agent.gemini.api-key", "test-key", "agent.gemini.model", "gemini-fake", "agent.max-attempts", "3");
    }

    @Override
    public void stop() {
        if (server != null) server.stop(0);
    }

    static String expected(String spec) {
        try (InputStream in = FakeGemini.class.getResourceAsStream("/specs/" + spec.replace(".md", ".expected.json"))) {
            if (in == null) return null;
            return JSON.readTree(in).toString();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private void handle(HttpExchange ex) throws IOException {
        try (ex) {
            JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
            Map<String, String> headers = new ConcurrentHashMap<>();
            ex.getRequestHeaders().forEach((k, v) -> headers.put(k.toLowerCase(), String.join(",", v)));
            REQUESTS.add(new Request(headers, body));
            String prompt = body.path("input").asText();
            Matcher m = FILE.matcher(prompt);
            String file = m.find() ? m.group(1) : "";
            int n = CALLS.computeIfAbsent(file, k -> new AtomicInteger()).incrementAndGet();
            boolean repair = prompt.contains("ERRORI DA CORREGGERE");
            switch (file) {
                case "errore-modello.md" -> reply(ex, 400, "{\"error\":{\"code\":400,\"message\":\"API key not valid\"}}");
                case "transitorio.md" -> {
                    if (n == 1) reply(ex, 503, "{\"error\":{\"code\":503,\"message\":\"overloaded\"}}");
                    else ok(ex, expected("conto-mono.md"));
                }
                case "riparabile.md" -> {
                    if (!repair) {
                        ObjectNode bad = (ObjectNode) JSON.readTree(expected("conto-mono.md"));
                        // dipendenza verso un blocco di un altro step: errore di validazione
                        ((ObjectNode) bad.at("/offer/blocks/1")).putArray("dependsOn").add("B_CRIBIS");
                        ok(ex, bad.toString());
                    } else {
                        ok(ex, expected("conto-mono.md"));
                    }
                }
                case "irreparabile.md" -> ok(ex, "{\"offer\":{\"id\":\"x\"}}");
                case "con-recinto.md" -> ok(ex, "```json\n" + expected("conto-mono.md") + "\n```");
                default -> {
                    String e = expected(file);
                    if (e == null) reply(ex, 500, "{\"error\":{\"message\":\"spec sconosciuta " + file + "\"}}");
                    else ok(ex, e);
                }
            }
        }
    }

    private static void ok(HttpExchange ex, String text) throws IOException {
        ObjectNode r = JSON.createObjectNode();
        r.put("object", "interaction");
        r.put("status", "completed");
        r.putArray("steps").addObject().put("type", "model_output").putArray("content").addObject().put("type", "text").put("text", text);
        reply(ex, 200, r.toString());
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    static InputStream spec(String name) {
        return FakeGemini.class.getResourceAsStream("/specs/" + name);
    }
}
