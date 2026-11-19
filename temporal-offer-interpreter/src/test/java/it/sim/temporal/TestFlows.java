package it.sim.temporal;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

/** Workflow di prova in src/test/resources/flows. */
final class TestFlows {

    static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());

    /** Generati da quarkus-flow-sim (solo sincroni) e dall'exporter della dashboard (offerta completa con callback). */
    static final List<String> ALL = List.of(
            "offer-off-sim.sw.yaml", "offer-off-sim-b-oracolo2.sw.yaml", "offer-off-sim-mono.sw.yaml",
            "offer-off-bundle.sw.yaml", "offer-off-bundle-b-oracolo2.sw.yaml");

    private TestFlows() {
    }

    static String text(String file) {
        try (InputStream in = TestFlows.class.getResourceAsStream("/flows/" + file)) {
            if (in == null) throw new IllegalStateException("risorsa mancante: /flows/" + file);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static JsonNode yaml(String file) {
        try {
            return YAML.readTree(text(file));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
