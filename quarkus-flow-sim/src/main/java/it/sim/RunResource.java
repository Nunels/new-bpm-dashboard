package it.sim;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.CompletionException;

import jakarta.enterprise.inject.Any;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import io.quarkiverse.flow.Flow;
import io.serverlessworkflow.impl.WorkflowError;
import io.serverlessworkflow.impl.WorkflowException;
import io.smallrye.common.annotation.Blocking;
import io.smallrye.common.annotation.Identifier;
import io.smallrye.mutiny.Uni;

/**
 * Avvia un workflow per identificatore (namespace:name[:version]) e restituisce un risultato strutturato:
 * { status: COMPLETED|NO_PRODUCTS|STOPPED|FAULTED, output, error }.
 */
@Path("/run")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class RunResource {

    @Inject
    @Any
    Instance<Flow> flows;

    /** Elenco dei workflow disponibili (diagnostica). */
    @GET
    public List<Map<String, String>> list() {
        List<Map<String, String>> out = new ArrayList<>();
        for (Flow f : flows) {
            Map<String, String> m = new LinkedHashMap<>();
            m.put("class", f.getClass().getName());
            try {
                var doc = f.descriptor().getDocument();
                m.put("document", doc.getNamespace() + ":" + doc.getName() + ":" + doc.getVersion());
            } catch (RuntimeException e) {
                m.put("error", String.valueOf(e));
            }
            out.add(m);
        }
        return out;
    }

    @POST
    @Path("/{id}")
    @Blocking
    public Uni<Map<String, Object>> run(@PathParam("id") String id, Map<String, Object> input) {
        Flow flow = find(id);
        if (flow == null) {
            return Uni.createFrom().item(Map.of("status", "UNKNOWN_WORKFLOW", "id", id));
        }
        return flow.startInstance(input == null ? Map.of() : input)
                .map(model -> {
                    Map<String, Object> result = new LinkedHashMap<>();
                    Map<String, Object> out = model.asMap().orElse(Map.of());
                    result.put("status", out.getOrDefault("status", "COMPLETED"));
                    result.put("output", out);
                    return result;
                })
                .onFailure().recoverWithItem(RunResource::failure);
    }

    /** Cerca il workflow per identificatore "namespace:name" (YAML) o per il namespace/nome del documento (Java DSL). */
    private Flow find(String id) {
        Instance<Flow> sel = flows.select(Identifier.Literal.of(id));
        if (sel.isResolvable()) return sel.get();
        for (Flow f : flows) {
            try {
                var doc = f.descriptor().getDocument();
                if ((doc.getNamespace() + ":" + doc.getName()).equals(id)) return f;
            } catch (RuntimeException ignored) {
                // workflow non ispezionabile: lo salto
            }
        }
        return null;
    }

    private static Map<String, Object> failure(Throwable t) {
        Throwable c = t;
        while (c != null && !(c instanceof WorkflowException)) {
            c = (c instanceof CompletionException || c.getCause() != c) ? c.getCause() : null;
        }
        Map<String, Object> result = new LinkedHashMap<>();
        if (c instanceof WorkflowException we) {
            WorkflowError e = we.getWorkflowError();
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("type", e.type());
            err.put("status", e.status());
            err.put("title", e.title());
            err.put("details", e.details());
            err.put("instance", e.instance());
            result.put("status", String.valueOf(e.type()).endsWith("offer-stopped") ? "STOPPED" : "FAULTED");
            result.put("error", err);
        } else {
            result.put("status", "FAULTED");
            result.put("error", Map.of("type", t.getClass().getName(), "title", String.valueOf(t.getMessage())));
        }
        return result;
    }
}
