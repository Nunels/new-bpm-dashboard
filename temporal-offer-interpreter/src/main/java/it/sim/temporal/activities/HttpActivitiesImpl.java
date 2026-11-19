package it.sim.temporal.activities;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.stream.Collectors;

import com.fasterxml.jackson.databind.ObjectMapper;

import io.temporal.failure.ApplicationFailure;

public final class HttpActivitiesImpl implements HttpActivities {

    /** Tipo di ApplicationFailure per gli errori di rete: il workflow lo traduce nell'errore "communication" della specifica. */
    public static final String NETWORK_ERROR = "NetworkError";

    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient client;

    public HttpActivitiesImpl() {
        this(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
    }

    public HttpActivitiesImpl(HttpClient client) {
        this.client = client;
    }

    @Override
    public HttpCall.Response call(HttpCall.Request r) {
        String uri = r.uri;
        if (r.query != null && !r.query.isEmpty()) {
            String qs = r.query.entrySet().stream()
                    .map(e -> enc(e.getKey()) + "=" + enc(e.getValue() == null ? "" : e.getValue()))
                    .collect(Collectors.joining("&"));
            uri = uri + (uri.contains("?") ? "&" : "?") + qs;
        }
        HttpRequest.BodyPublisher body = r.bodyJson == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(r.bodyJson, StandardCharsets.UTF_8);
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(uri)).method(r.method.toUpperCase(), body);
        if (r.bodyJson != null) b.header("Content-Type", "application/json");
        b.header("Accept", "application/json");
        if (r.headers != null) r.headers.forEach(b::setHeader);
        try {
            HttpResponse<String> resp = client.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            HttpCall.Response out = new HttpCall.Response();
            out.status = resp.statusCode();
            resp.headers().map().forEach((k, v) -> out.headers.put(k, String.join(",", v)));
            out.bodyJson = toJson(resp.body());
            return out;
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("chiamata HTTP fallita: " + r.method + " " + uri + " (" + e + ")", NETWORK_ERROR);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApplicationFailure.newFailure("chiamata HTTP interrotta: " + uri, NETWORK_ERROR);
        }
    }

    private static String toJson(String body) {
        if (body == null || body.isBlank()) return "null";
        try {
            return JSON.readTree(body).toString();
        } catch (IOException notJson) {
            return JSON.getNodeFactory().textNode(body).toString();
        }
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
