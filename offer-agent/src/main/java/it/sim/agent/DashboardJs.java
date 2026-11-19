package it.sim.agent;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;

import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Engine;
import org.graalvm.polyglot.Source;
import org.graalvm.polyglot.Value;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Esegue in GraalJS il codice della dashboard (validazione, Execution Plan, exporter, importer DSL): lo stesso
 * codice che gira nel browser, copiato nel classpath a build time da ../offer-dashboard. Un contesto JS non è
 * thread-safe: le chiamate sono serializzate.
 */
@ApplicationScoped
public class DashboardJs {

    static final List<String> SCRIPTS = List.of(
            "js/vendor/js-yaml/js-yaml.min.js", "js/seed.js", "js/fields.js", "js/store.js", "js/validation.js", "js/simulator.js",
            "js/exporters/common.js", "js/exporters/serverless.js", "js/exporters/temporal.js", "js/execution-plan.js", "js/dsl-import.js");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PRELUDE = String.join("\n",
            "var window = globalThis;",
            "var __store = {};",
            "var localStorage = { getItem: function (k) { return __store[k] || null; }, setItem: function (k, v) { __store[k] = String(v); }, removeItem: function (k) { delete __store[k]; } };",
            "var document = { getElementById: function () { return null; }, createElement: function () { return {}; }, createElementNS: function () { return {}; } };",
            "var Node = function () {};");

    private final Engine engine = Engine.newBuilder("js").option("engine.WarnInterpreterOnly", "false").build();
    private final Context context;

    public DashboardJs() {
        context = Context.newBuilder("js").engine(engine).allowAllAccess(false).build();
        context.eval(Source.create("js", PRELUDE));
        for (String s : SCRIPTS) context.eval(source("dashboard/" + s, s));
        context.eval(source("agent-bridge.js", "agent-bridge.js"));
    }

    private static Source source(String resource, String name) {
        try (InputStream in = DashboardJs.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) throw new IllegalStateException("script mancante nel classpath: " + resource + " (la build copia ../offer-dashboard)");
            return Source.newBuilder("js", new String(in.readAllBytes(), StandardCharsets.UTF_8), name).build();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Analisi completa di un'offerta rispetto al catalogo: validazione, DSL, simulazione, andata e ritorno. */
    public synchronized JsonNode analyze(JsonNode catalog, JsonNode offer) {
        Value fn = context.getBindings("js").getMember("analyzeOffer");
        return read(fn.execute(catalog.toString(), offer.toString()).asString());
    }

    /** Step fissi del processo (dal seed della dashboard). */
    public synchronized JsonNode steps() {
        return read(context.getBindings("js").getMember("stepsJson").execute().asString());
    }

    /** Catalogo e offerte demo della dashboard. */
    public synchronized JsonNode seed() {
        return read(context.getBindings("js").getMember("seedJson").execute().asString());
    }

    private static JsonNode read(String json) {
        try {
            return JSON.readTree(json);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @PreDestroy
    void close() {
        context.close();
        engine.close();
    }
}
