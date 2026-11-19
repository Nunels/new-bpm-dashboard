package it.sim.agent;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

/**
 * Schema della risposta dell'agente (offer-generation.schema.json della dashboard) specializzato sul catalogo:
 * gli id ammessi di prodotti, task e step diventano enum, così il modello non può inventarli.
 */
public final class OfferSchema {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Parole chiave che il nostro validatore applica ma che non mandiamo al modello (supporto non garantito). */
    private static final List<String> MODEL_UNSUPPORTED = List.of("$schema", "$id", "pattern", "uniqueItems", "minLength");

    private final ObjectNode schema;
    private final JsonSchema validator;

    private OfferSchema(ObjectNode schema) {
        this.schema = schema;
        this.validator = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012).getSchema(schema);
    }

    static ObjectNode base() {
        try (InputStream in = OfferSchema.class.getClassLoader().getResourceAsStream("dashboard/schema/offer-generation.schema.json")) {
            if (in == null) throw new IllegalStateException("schema mancante: dashboard/schema/offer-generation.schema.json");
            return (ObjectNode) JSON.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Schema con gli enum del catalogo. steps = step fissi del processo (l'ultimo non ammette barre in uscita). */
    public static OfferSchema forCatalog(JsonNode catalog, JsonNode steps) {
        ObjectNode s = base();
        List<String> products = ids(catalog.path("products"));
        List<String> tasks = ids(catalog.path("tasks"));
        List<String> stepIds = ids(steps);
        List<String> gateSteps = stepIds.isEmpty() ? stepIds : stepIds.subList(0, stepIds.size() - 1);
        ObjectNode offer = (ObjectNode) s.at("/properties/offer/properties");
        enumOf((ObjectNode) offer.at("/products/items"), products);
        ObjectNode block = (ObjectNode) offer.at("/blocks/items/properties");
        enumOf((ObjectNode) block.get("taskId"), tasks);
        enumOf((ObjectNode) block.get("stepId"), stepIds);
        enumOf((ObjectNode) block.at("/products/items"), products);
        ObjectNode gate = (ObjectNode) offer.at("/gates/items/properties");
        enumOf((ObjectNode) gate.get("afterStep"), gateSteps);
        enumOf((ObjectNode) gate.at("/rules/items/properties/products/items"), products);
        return new OfferSchema(s);
    }

    private static List<String> ids(JsonNode list) {
        List<String> out = new ArrayList<>();
        list.forEach(n -> out.add(n.path("id").asText()));
        return out;
    }

    private static void enumOf(ObjectNode node, List<String> values) {
        ArrayNode a = node.putArray("enum");
        values.forEach(a::add);
    }

    /** Errori di schema della risposta (vuoto = conforme), ordinati e leggibili. */
    public List<String> validate(JsonNode response) {
        TreeSet<String> out = new TreeSet<>();
        for (ValidationMessage m : validator.validate(response)) out.add(m.getInstanceLocation() + ": " + m.getMessage());
        return new ArrayList<>(out);
    }

    /** Versione dello schema da inviare al modello (senza le parole chiave dal supporto incerto). */
    public ObjectNode forModel() {
        ObjectNode copy = schema.deepCopy();
        strip(copy);
        return copy;
    }

    private static void strip(JsonNode n) {
        if (n.isObject()) {
            ObjectNode o = (ObjectNode) n;
            MODEL_UNSUPPORTED.forEach(o::remove);
            Iterator<Map.Entry<String, JsonNode>> it = o.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                // dentro "properties" le chiavi sono nomi di campo, non parole chiave dello schema
                if (e.getKey().equals("properties")) e.getValue().forEach(OfferSchema::strip);
                else strip(e.getValue());
            }
        } else if (n.isArray()) {
            n.forEach(OfferSchema::strip);
        }
    }

    public ObjectNode json() {
        return schema.deepCopy();
    }
}
