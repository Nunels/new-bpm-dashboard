package it.sim.temporal;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Servizi simulati con gli stessi path e lo stesso contratto di quarkus-flow-sim:
 * risposta { service, outcome, productOutcomes: { PRODOTTO: OK|KO }, scoreRischio, rating }.
 * Esiti, latenza ed errori 503 sono configurabili per servizio.
 */
final class MockServices implements AutoCloseable {

    record Call(String service, String method, String path, List<String> products) {
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpServer server;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, Map<String, String>> outcomes = new ConcurrentHashMap<>();
    private final Map<String, Long> latency = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> failures = new ConcurrentHashMap<>();
    private final List<Call> calls = new CopyOnWriteArrayList<>();
    private final AtomicInteger inFlight = new AtomicInteger();

    MockServices() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** I workflow generati puntano a localhost:8089 (quarkus-flow-sim) o a api.example.internal (dashboard): li redirigo qui. */
    String rewrite(String yaml) {
        return yaml.replace("http://localhost:8089", baseUrl()).replace("https://api.example.internal", baseUrl());
    }

    void reset() {
        outcomes.clear();
        latency.clear();
        failures.clear();
        calls.clear();
    }

    void configure(JsonNode outcomesConfig, JsonNode latencyConfig) {
        reset();
        outcomesConfig.fields().forEachRemaining(s -> {
            Map<String, String> m = new ConcurrentHashMap<>();
            s.getValue().fields().forEachRemaining(p -> m.put(p.getKey(), p.getValue().asText()));
            outcomes.put(s.getKey(), m);
        });
        latencyConfig.fields().forEachRemaining(e -> latency.put(e.getKey(), e.getValue().asLong()));
    }

    /** Le prossime n chiamate al servizio rispondono 503. */
    void failNext(String service, int n) {
        failures.put(service, new AtomicInteger(n));
    }

    List<Call> calls() {
        return new ArrayList<>(calls);
    }

    /** Richieste ancora in elaborazione (per esempio un ramo "non atteso" con latenza). */
    int inFlight() {
        return inFlight.get();
    }

    Map<String, Integer> callsPerService() {
        Map<String, Integer> m = new TreeMap<>();
        calls.forEach(c -> m.merge(c.service(), 1, Integer::sum));
        return m;
    }

    boolean await(Predicate<MockServices> condition, Duration max) throws InterruptedException {
        long end = System.currentTimeMillis() + max.toMillis();
        while (System.currentTimeMillis() < end) {
            if (condition.test(this)) return true;
            Thread.sleep(50);
        }
        return condition.test(this);
    }

    static String serviceOf(String path) {
        if (path.equals("oracolo/v1/check")) return "ORACOLO";
        if (path.equals("partner/tim/v1/oracolo")) return "ORACOLO_2";
        if (path.equals("pregiudizievoli/v1/check")) return "PREGIUDIZIEVOLI";
        if (path.startsWith("cribis/v1/rating")) return "CRIBIS";
        if (path.equals("corebanking/v1/attivazioni")) return "ATTIVAZIONE_BANCARIA";
        if (path.equals("comunicazioni/v1/invio")) return "COMUNICAZIONI";
        if (path.equals("contratti/v1/stampa")) return "STAMPA_CONTRATTI";
        if (path.equals("documenti/v1/verifica")) return "VERIFICA_DOCUMENTO";
        if (path.equals("backoffice/v1/pratiche")) return "PRESA_IN_CARICO_BO";
        if (path.equals("partner/tim/v1/attivazioni")) return "ATTIVAZIONE_TIM";
        return null;
    }

    private void handle(HttpExchange ex) throws IOException {
        inFlight.incrementAndGet();
        try (ex) {
            String path = ex.getRequestURI().getPath().replaceFirst("^/", "").replaceFirst("^mock/", "");
            String service = serviceOf(path);
            if (service == null) {
                reply(ex, 404, "{\"error\":\"servizio simulato sconosciuto: " + path + "\"}");
                return;
            }
            List<String> products = new ArrayList<>();
            byte[] raw;
            try (InputStream in = ex.getRequestBody()) {
                raw = in.readAllBytes();
            }
            if (raw.length > 0) {
                JsonNode body = JSON.readTree(raw);
                body.path("products").forEach(p -> products.add(p.asText()));
            }
            String q = ex.getRequestURI().getRawQuery();
            if (q != null) {
                for (String kv : q.split("&")) {
                    String[] parts = kv.split("=", 2);
                    if (parts[0].equals("products") && parts.length == 2) {
                        for (String p : URLDecoder.decode(parts[1], StandardCharsets.UTF_8).split(",")) if (!p.isBlank()) products.add(p.trim());
                    }
                }
            }
            calls.add(new Call(service, ex.getRequestMethod(), path, products));
            long delay = latency.getOrDefault(service, 0L);
            if (delay > 0) Thread.sleep(delay);
            AtomicInteger f = failures.get(service);
            if (f != null && f.getAndDecrement() > 0) {
                reply(ex, 503, "{\"error\":\"servizio temporaneamente non disponibile\"}");
                return;
            }
            ObjectNode out = JSON.createObjectNode();
            out.put("service", service);
            ObjectNode po = out.putObject("productOutcomes");
            boolean ko = false;
            for (String p : products) {
                String o = outcomes.getOrDefault(service, Map.of()).getOrDefault(p, "OK");
                po.put(p, o);
                ko |= o.equals("KO");
            }
            out.put("outcome", ko ? "KO" : "OK");
            out.put("scoreRischio", 10);
            out.put("rating", "A");
            reply(ex, 200, out.toString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            inFlight.decrementAndGet();
        }
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
    }
}
