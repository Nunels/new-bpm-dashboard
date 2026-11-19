package it.sim;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import jakarta.enterprise.context.ApplicationScoped;

/** Stato dei servizi simulati: esiti configurati per servizio e prodotto, latenza e registro delle chiamate. */
@ApplicationScoped
public class MockState {

    public record Call(Instant at, String service, String method, String path, List<String> products, Map<String, Object> body) {
    }

    private final Map<String, Map<String, String>> outcomes = new ConcurrentHashMap<>();
    private final Map<String, Long> latencyMs = new ConcurrentHashMap<>();
    private final List<Call> calls = new CopyOnWriteArrayList<>();

    public void reset() {
        outcomes.clear();
        latencyMs.clear();
        calls.clear();
    }

    public void setOutcomes(Map<String, Map<String, String>> config) {
        outcomes.clear();
        config.forEach((service, perProduct) -> outcomes.put(service, new HashMap<>(perProduct)));
    }

    public void setLatency(Map<String, Long> config) {
        latencyMs.clear();
        latencyMs.putAll(config);
    }

    public String outcomeFor(String service, String product) {
        return outcomes.getOrDefault(service, Map.of()).getOrDefault(product, "OK");
    }

    public long latencyFor(String service) {
        return latencyMs.getOrDefault(service, 0L);
    }

    public void record(Call call) {
        calls.add(call);
    }

    public List<Call> calls() {
        return Collections.unmodifiableList(new ArrayList<>(calls));
    }
}
