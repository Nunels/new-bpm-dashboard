package it.sim.temporal.app;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import it.sim.temporal.workflow.RunResult;

/**
 * Traduce l'esito tecnico del workflow nello stato dell'offerta, secondo le convenzioni dell'exporter della dashboard:
 * output.status (COMPLETED / NO_PRODUCTS) se il workflow è completato, STOPPED se è terminato con l'errore offer-stopped.
 */
public record OfferOutcome(String status, JsonNode output, JsonNode error) {

    private static final ObjectMapper JSON = new ObjectMapper();

    public static OfferOutcome of(RunResult r) {
        try {
            JsonNode output = r.outputJson == null ? null : JSON.readTree(r.outputJson);
            JsonNode error = r.errorJson == null ? null : JSON.readTree(r.errorJson);
            String status;
            if ("COMPLETED".equals(r.status)) status = output != null && output.hasNonNull("status") ? output.get("status").asText() : "COMPLETED";
            else status = error != null && error.path("type").asText().endsWith("/offer-stopped") ? "STOPPED" : "FAULTED";
            return new OfferOutcome(status, output, error);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("risultato non leggibile", e);
        }
    }

    /** Prodotti ancora attivi a fine pratica (vuoto se l'offerta si è fermata). */
    public java.util.List<String> activeProducts() {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (output != null) output.path("activeProducts").forEach(p -> out.add(p.asText()));
        return out;
    }
}
