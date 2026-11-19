package it.sim.agent;

import java.util.Map;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import org.eclipse.microprofile.config.inject.ConfigProperty;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * API usata da generate.html.
 * POST /api/generations { fileName, specText, catalog: { products, tasks } } → 202 { id }
 * GET  /api/generations/{id} → stato del job; GET /api/config → modello configurato.
 */
@Path("/api")
@Produces(MediaType.APPLICATION_JSON)
public class GenerationResource {

    public record GenerationRequest(String fileName, String specText, JsonNode catalog) {
    }

    private final GenerationService service;
    private final int maxSpecChars;

    public GenerationResource(GenerationService service, @ConfigProperty(name = "agent.max-spec-chars") int maxSpecChars) {
        this.service = service;
        this.maxSpecChars = maxSpecChars;
    }

    @GET
    @Path("/config")
    public Map<String, Object> config() {
        return Map.of("model", service.model().name(), "configured", service.model().configured(),
                "maxAttempts", service.maxAttempts(), "maxSpecChars", maxSpecChars);
    }

    @POST
    @Path("/generations")
    @Consumes(MediaType.APPLICATION_JSON)
    public Response start(GenerationRequest req) {
        if (req == null || req.specText() == null || req.specText().isBlank()) return bad("Il file delle specifiche è vuoto.");
        if (req.specText().length() > maxSpecChars) return bad("Il file supera il limite di " + maxSpecChars + " caratteri.");
        JsonNode c = req.catalog();
        if (c == null || !c.path("products").isArray() || !c.path("tasks").isArray() || c.path("products").isEmpty() || c.path("tasks").isEmpty()) {
            return bad("Catalogo mancante: servono products e tasks.");
        }
        if (!service.model().configured()) return bad("Il modello non è configurato sul server (variabile GEMINI_API_KEY).");
        String name = req.fileName() == null || req.fileName().isBlank() ? "specifiche.md" : req.fileName();
        GenerationJob job = service.start(name, req.specText(), c);
        return Response.accepted(Map.of("id", job.id)).build();
    }

    @GET
    @Path("/generations/{id}")
    public Response get(@PathParam("id") String id) {
        return service.find(id).map(j -> Response.ok(j).build())
                .orElse(Response.status(404).entity(Map.of("error", "generazione non trovata: " + id)).build());
    }

    private static Response bad(String message) {
        return Response.status(400).entity(Map.of("error", message)).build();
    }
}
