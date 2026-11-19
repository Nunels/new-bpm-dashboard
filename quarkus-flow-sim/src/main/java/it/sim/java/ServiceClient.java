package it.sim.java;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import jakarta.enterprise.context.ApplicationScoped;

import org.eclipse.microprofile.config.inject.ConfigProperty;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.quarkus.arc.Unremovable;

/** Client Java dei servizi: traduce un'attività dell'Execution Plan in una chiamata HTTP (con retry). */
@ApplicationScoped
@Unremovable
public class ServiceClient {

    static final ObjectMapper JSON = new ObjectMapper();
    static final Pattern PLACEHOLDER = Pattern.compile("\\{(\\w+)}");

    @ConfigProperty(name = "sim.services.base-url", defaultValue = "http://localhost:8089/mock")
    String baseUrl;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    /** Esegue una chiamata per i prodotti indicati e restituisce { outcome, productOutcomes, ... }. */
    public JsonNode call(JsonNode activity, Map<String, Object> state, List<String> products) {
        try {
            String method = activity.at("/service/method").asText("POST").toUpperCase();
            Map<String, Object> inputs = new LinkedHashMap<>();
            for (JsonNode in : activity.path("input")) {
                inputs.put(in.get("name").asText(), OfferInterpreter.resolve(in.path("source").asText(null), state));
            }

            String path = activity.at("/service/path").asText("");
            Matcher m = PLACEHOLDER.matcher(path);
            StringBuilder sb = new StringBuilder();
            while (m.find()) {
                Object v = inputs.get(m.group(1));
                m.appendReplacement(sb, Matcher.quoteReplacement(URLEncoder.encode(String.valueOf(v), StandardCharsets.UTF_8)));
            }
            m.appendTail(sb);
            String url = baseUrl + sb;

            HttpRequest.Builder req = HttpRequest.newBuilder().timeout(Duration.ofSeconds(60)).header("Accept", "application/json");
            if (method.equals("GET")) {
                req.uri(URI.create(url + "?products=" + URLEncoder.encode(String.join(",", products), StandardCharsets.UTF_8))).GET();
            } else {
                Map<String, Object> body = new LinkedHashMap<>(inputs);
                body.put("products", products);
                req.uri(URI.create(url)).header("Content-Type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
            }

            int attempts = activity.at("/retry/maxAttempts").asInt(0) + 1;
            long intervalMs = Math.min(activity.at("/retry/intervalSec").asLong(1), 2) * 1000;
            Exception last = null;
            for (int i = 0; i < attempts; i++) {
                try {
                    HttpResponse<String> r = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
                    if (r.statusCode() < 500) return JSON.readTree(r.body());
                    last = new IllegalStateException("HTTP " + r.statusCode());
                } catch (java.io.IOException e) {
                    last = e;
                }
                if (i < attempts - 1) Thread.sleep(intervalMs);
            }
            throw new IllegalStateException("chiamata fallita dopo " + attempts + " tentativi: " + last);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
