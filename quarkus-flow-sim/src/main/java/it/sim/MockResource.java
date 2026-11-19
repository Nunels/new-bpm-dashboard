package it.sim;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import io.smallrye.mutiny.Uni;

/**
 * Servizi simulati degli stessi path del catalogo della dashboard, sotto /mock.
 * Contratto di risposta: { outcome, productOutcomes: { PRODOTTO: OK|KO }, ...output }.
 */
@Path("/")
@Produces(MediaType.APPLICATION_JSON)
public class MockResource {

    @Inject
    MockState state;

    static String serviceOf(String path) {
        if (path.equals("oracolo/v1/check")) return "ORACOLO";
        if (path.equals("partner/tim/v1/oracolo")) return "ORACOLO_2";
        if (path.equals("pregiudizievoli/v1/check")) return "PREGIUDIZIEVOLI";
        if (path.startsWith("cribis/v1/rating")) return "CRIBIS";
        if (path.equals("corebanking/v1/attivazioni")) return "ATTIVAZIONE_BANCARIA";
        if (path.equals("comunicazioni/v1/invio")) return "COMUNICAZIONI";
        if (path.equals("contratti/v1/stampa")) return "STAMPA_CONTRATTI";
        if (path.equals("documenti/v1/verifica")) return "VERIFICA_DOCUMENTO";
        return null;
    }

    @POST
    @Path("/mock/{path: .+}")
    @Consumes(MediaType.WILDCARD)
    public Uni<Response> post(@PathParam("path") String path, Map<String, Object> body) {
        return handle("POST", path, body, null);
    }

    @GET
    @Path("/mock/{path: .+}")
    public Uni<Response> get(@PathParam("path") String path, @QueryParam("products") String products) {
        return handle("GET", path, Map.of(), products);
    }

    @SuppressWarnings("unchecked")
    private Uni<Response> handle(String method, String path, Map<String, Object> body, String productsQuery) {
        String service = serviceOf(path);
        if (service == null) {
            return Uni.createFrom().item(Response.status(404).entity(Map.of("error", "servizio simulato sconosciuto: " + path)).build());
        }
        List<String> products = new ArrayList<>();
        Object p = body == null ? null : body.get("products");
        if (p instanceof List<?> l) l.forEach(x -> products.add(String.valueOf(x)));
        if (productsQuery != null && !productsQuery.isBlank()) {
            for (String x : productsQuery.split(",")) products.add(x.trim());
        }
        state.record(new MockState.Call(Instant.now(), service, method, path, products, body == null ? Map.of() : body));

        Map<String, Object> productOutcomes = new LinkedHashMap<>();
        for (String prod : products) productOutcomes.put(prod, state.outcomeFor(service, prod));
        boolean anyKo = productOutcomes.containsValue("KO");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", service);
        out.put("outcome", anyKo ? "KO" : "OK");
        out.put("productOutcomes", productOutcomes);
        out.put("scoreRischio", 10);
        out.put("rating", "A");

        Response response = Response.ok(out).build();
        long delay = state.latencyFor(service);
        Uni<Response> result = Uni.createFrom().item(response);
        return delay > 0 ? result.onItem().delayIt().by(Duration.ofMillis(delay)) : result;
    }

    /* ---------------- comandi di controllo ---------------- */

    @POST
    @Path("/sim/reset")
    public Response reset() {
        state.reset();
        return Response.noContent().build();
    }

    /** Body: { "ORACOLO": { "EVO": "KO" }, "CRIBIS": { "CONTO": "KO" } } */
    @PUT
    @Path("/sim/outcomes")
    @Consumes(MediaType.APPLICATION_JSON)
    public Response outcomes(Map<String, Map<String, String>> config) {
        state.setOutcomes(config);
        return Response.noContent().build();
    }

    /** Body: { "ORACOLO_2": 3000 } (millisecondi) */
    @PUT
    @Path("/sim/latency")
    @Consumes(MediaType.APPLICATION_JSON)
    public Response latency(Map<String, Number> config) {
        Map<String, Long> m = new LinkedHashMap<>();
        config.forEach((k, v) -> m.put(k, v.longValue()));
        state.setLatency(m);
        return Response.noContent().build();
    }

    @GET
    @Path("/sim/calls")
    public List<MockState.Call> calls() {
        return state.calls();
    }
}
