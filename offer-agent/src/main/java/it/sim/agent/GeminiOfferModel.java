package it.sim.agent;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;
import org.jboss.logging.MDC;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Gemini tramite l'API REST "interactions" (output strutturato con JSON Schema, vedi
 * https://ai.google.dev/gemini-api/docs/structured-output). La chiave resta sul server.
 *
 * Log di ogni chiamata (categoria it.sim.agent.GeminiOfferModel): modello, URL, dimensioni, esito HTTP, durata e
 * token usati, con l'id della generazione (MDC "job"). La chiave non viene mai loggata. Il testo delle specifiche e
 * le risposte del modello compaiono nei log solo con agent.gemini.log-payloads=true (da usare in sviluppo, con dati fittizi).
 */
@ApplicationScoped
public class GeminiOfferModel implements OfferModel {

    private static final Logger LOG = Logger.getLogger(GeminiOfferModel.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final AtomicLong CALLS = new AtomicLong();

    private final String apiKey;
    private final String model;
    private final String baseUrl;
    private final String apiRevision;
    private final Duration timeout;
    private final boolean logPayloads;
    private final HttpClient http;

    @Inject
    public GeminiOfferModel(@ConfigProperty(name = "agent.gemini.api-key", defaultValue = "") String apiKey,
            @ConfigProperty(name = "agent.gemini.model") String model,
            @ConfigProperty(name = "agent.gemini.base-url") String baseUrl,
            @ConfigProperty(name = "agent.gemini.api-revision") String apiRevision,
            @ConfigProperty(name = "agent.gemini.timeout") Duration timeout,
            @ConfigProperty(name = "agent.gemini.log-payloads", defaultValue = "false") boolean logPayloads) {
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.model = model;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiRevision = apiRevision;
        this.timeout = timeout;
        this.logPayloads = logPayloads;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    }

    /** Costruttore per chi non usa CDI (EvalRunner): payload non loggati. */
    public GeminiOfferModel(String apiKey, String model, String baseUrl, String apiRevision, Duration timeout) {
        this(apiKey, model, baseUrl, apiRevision, timeout, false);
    }

    @Override
    public String name() {
        return model;
    }

    @Override
    public boolean configured() {
        return !apiKey.isEmpty();
    }

    @Override
    public String generate(String prompt, JsonNode responseSchema) throws ModelException {
        if (!configured()) throw new ModelException("chiave del modello non configurata (variabile GEMINI_API_KEY)", false);
        ObjectNode body = JSON.createObjectNode();
        body.put("model", model);
        body.put("input", prompt);
        ObjectNode format = body.putObject("response_format");
        format.put("type", "text");
        format.put("mime_type", "application/json");
        format.set("schema", responseSchema);
        String payload = body.toString();
        String url = baseUrl + "/v1beta/interactions";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .timeout(timeout)
                .header("x-goog-api-key", apiKey)
                .header("Content-Type", "application/json")
                .header("Api-Revision", apiRevision)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();

        String id = tag();
        LOG.infof("%s richiesta: POST %s model=%s apiRevision=%s promptChars=%d schemaChars=%d bodyBytes=%d timeout=%s",
                id, url, model, apiRevision, prompt.length(), responseSchema.toString().length(),
                payload.getBytes(StandardCharsets.UTF_8).length, timeout);
        if (logPayloads) LOG.infof("%s prompt:\n%s", id, prompt);

        long t0 = System.nanoTime();
        HttpResponse<String> resp;
        try {
            resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            LOG.warnf("%s fallita dopo %d ms: %s: %s", id, since(t0), e.getClass().getSimpleName(), e.getMessage());
            throw new ModelException("modello non raggiungibile: " + e.getMessage(), true);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.warnf("%s interrotta dopo %d ms", id, since(t0));
            throw new ModelException("chiamata al modello interrotta", false);
        }
        long millis = since(t0);
        String requestId = resp.headers().firstValue("x-request-id").or(() -> resp.headers().firstValue("x-goog-request-id")).orElse("-");
        if (resp.statusCode() != 200) {
            boolean retry = resp.statusCode() == 429 || resp.statusCode() >= 500;
            String message = errorMessage(resp.body());
            LOG.warnf("%s risposta: status=%d millis=%d responseBytes=%d requestId=%s retryable=%s errore=%s", id, resp.statusCode(), millis,
                    resp.body() == null ? 0 : resp.body().length(), requestId, retry, message);
            if (logPayloads) LOG.infof("%s corpo della risposta:\n%s", id, resp.body());
            throw new ModelException("il modello ha risposto " + resp.statusCode() + ": " + message, retry);
        }
        try {
            String text = text(resp.body());
            LOG.infof("%s risposta: status=200 millis=%d responseBytes=%d textChars=%d requestId=%s %s", id, millis, resp.body().length(),
                    text.length(), requestId, usage(resp.body()));
            if (logPayloads) LOG.infof("%s testo generato:\n%s", id, text);
            return text;
        } catch (ModelException e) {
            LOG.warnf("%s risposta non utilizzabile: status=200 millis=%d requestId=%s motivo=%s", id, millis, requestId, e.getMessage());
            if (logPayloads) LOG.infof("%s corpo della risposta:\n%s", id, resp.body());
            throw e;
        }
    }

    /** Prefisso di correlazione: numero progressivo della chiamata e, se presente, id della generazione (MDC "job"). */
    private static String tag() {
        Object job = MDC.get("job");
        return "gemini#" + CALLS.incrementAndGet() + (job == null ? "" : " job=" + job);
    }

    private static long since(long t0) {
        return (System.nanoTime() - t0) / 1_000_000;
    }

    /** Token usati, dal campo usage della risposta (se presente). */
    static String usage(String responseBody) {
        try {
            JsonNode u = JSON.readTree(responseBody).path("usage");
            if (u.isMissingNode()) return "tokens=n/d";
            return "tokensInput=" + u.path("total_input_tokens").asText("?") + " tokensOutput=" + u.path("total_output_tokens").asText("?")
                    + " tokensThought=" + u.path("total_thought_tokens").asText("?") + " tokensTotal=" + u.path("total_tokens").asText("?");
        } catch (IOException e) {
            return "tokens=n/d";
        }
    }

    /** Testo della risposta: contenuti di tipo text degli step model_output (formato dell'API interactions). */
    static String text(String responseBody) throws ModelException {
        JsonNode r;
        try {
            r = JSON.readTree(responseBody);
        } catch (IOException e) {
            throw new ModelException("risposta del modello non leggibile", true);
        }
        String status = r.path("status").asText("completed");
        if (!"completed".equals(status)) throw new ModelException("generazione non completata (stato " + status + ")", true);
        StringBuilder sb = new StringBuilder();
        for (JsonNode step : r.path("steps")) {
            if (!"model_output".equals(step.path("type").asText())) continue;
            for (JsonNode c : step.path("content")) if ("text".equals(c.path("type").asText())) sb.append(c.path("text").asText());
        }
        if (sb.length() == 0) throw new ModelException("il modello non ha restituito testo", true);
        return sb.toString();
    }

    private static String errorMessage(String body) {
        try {
            JsonNode n = JSON.readTree(body);
            String m = n.path("error").path("message").asText("");
            return m.isEmpty() ? truncate(body) : m;
        } catch (IOException e) {
            return truncate(body);
        }
    }

    private static String truncate(String s) {
        return s == null ? "" : s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }
}
