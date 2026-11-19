package it.sim;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.RestAssured;
import io.restassured.config.HttpClientConfig;
import io.restassured.config.RestAssuredConfig;
import io.restassured.http.ContentType;

/**
 * Esegue gli scenari generati dalla dashboard (scenarios.json) sul workflow caricato da Quarkus Flow e
 * confronta stato finale, prodotti attivi, numero di chiamate per servizio e (se richiesto) i tempi
 * con quanto atteso dal Simulator della dashboard.
 * Il workflow è selezionabile con -Dsim.variant=a (YAML generato, default) oppure b (variante Java).
 */
@QuarkusTest
class ScenarioTest {

    static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void http() {
        RestAssured.config = RestAssuredConfig.config().httpClient(HttpClientConfig.httpClientConfig()
                .setParam("http.socket.timeout", 60000).setParam("http.connection.timeout", 5000));
    }

    static Stream<JsonNode> scenarios() throws Exception {
        try (InputStream in = ScenarioTest.class.getResourceAsStream("/scenarios.json")) {
            List<JsonNode> list = new ArrayList<>();
            JSON.readTree(in).forEach(list::add);
            String only = System.getProperty("sim.only");
            return list.stream().filter(n -> only == null || (n.get("offerId").asText() + "/" + n.get("name").asText()).contains(only));
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(JsonNode sc) throws Exception {
        String variant = System.getProperty("sim.variant", "a");
        String workflow = variant.equals("b") ? sc.get("workflow").asText().replace("offers:", "offers-java:") : sc.get("workflow").asText();

        given().when().post("/sim/reset").then().statusCode(204);
        given().contentType(ContentType.JSON).body(sc.get("mock").toString()).when().put("/sim/outcomes").then().statusCode(204);
        given().contentType(ContentType.JSON).body(sc.get("latency").toString()).when().put("/sim/latency").then().statusCode(204);

        long t0 = System.currentTimeMillis();
        String body = given().contentType(ContentType.JSON).body(sc.get("input").toString())
                .when().post("/run/" + workflow).then().extract().asString();
        long elapsed = System.currentTimeMillis() - t0;
        JsonNode result = JSON.readTree(body);

        // lascia concludere gli eventuali rami "non attesi"
        long maxLatency = 0;
        for (JsonNode l : sc.get("latency")) maxLatency = Math.max(maxLatency, l.asLong());
        if (maxLatency > 0) Thread.sleep(maxLatency + 500);

        List<String> problems = new ArrayList<>();
        String expStatus = sc.get("expected").get("status").asText();
        String gotStatus = result.path("status").asText();
        if (!expStatus.equals(gotStatus)) problems.add("stato: atteso " + expStatus + " ma ottenuto " + gotStatus);

        TreeSet<String> expActive = new TreeSet<>();
        sc.get("expected").get("activeProducts").forEach(n -> expActive.add(n.asText()));
        TreeSet<String> gotActive = new TreeSet<>();
        result.path("output").path("activeProducts").forEach(n -> gotActive.add(n.asText()));
        if (!expActive.equals(gotActive)) problems.add("prodotti attivi: attesi " + expActive + " ma ottenuti " + gotActive);

        Map<String, Integer> gotCalls = new TreeMap<>();
        JsonNode calls = JSON.readTree(given().when().get("/sim/calls").asString());
        calls.forEach(c -> gotCalls.merge(c.get("service").asText(), 1, Integer::sum));
        Map<String, Integer> expCalls = new TreeMap<>();
        sc.get("expectedCalls").fields().forEachRemaining(e -> { if (e.getValue().asInt() > 0) expCalls.put(e.getKey(), e.getValue().asInt()); });
        if (!expCalls.equals(gotCalls)) problems.add("chiamate per servizio: attese " + expCalls + " ma ottenute " + gotCalls);

        // prodotti inviati a ciascun servizio (un blocco dipendente da un KO non deve riceverli)
        Map<String, TreeSet<String>> gotProducts = new TreeMap<>();
        calls.forEach(c -> {
            TreeSet<String> set = gotProducts.computeIfAbsent(c.get("service").asText(), k -> new TreeSet<>());
            c.get("products").forEach(p -> set.add(p.asText()));
        });
        Map<String, TreeSet<String>> expProducts = new TreeMap<>();
        sc.get("expectedProducts").fields().forEachRemaining(e -> {
            TreeSet<String> set = new TreeSet<>();
            e.getValue().forEach(p -> set.add(p.asText()));
            if (!set.isEmpty()) expProducts.put(e.getKey(), set);
        });
        if (!expProducts.equals(gotProducts)) problems.add("prodotti inviati ai servizi: attesi " + expProducts + " ma ottenuti " + gotProducts);

        if (sc.hasNonNull("maxMillis")) {
            long limit = sc.get("maxMillis").asLong();
            if (variant.equals("a")) {
                // Limite noto di Quarkus Flow 1.3.0: "run: workflow" con "await: false" viene atteso comunque.
                // Il test fa da segnale: se un runtime futuro lo rispetta, fallisce e va aggiornata la documentazione.
                if (elapsed < maxLatency) problems.add("limite risolto? il ramo non atteso ha richiesto solo " + elapsed + " ms (< " + maxLatency
                        + " ms di latenza): aggiornare README e note dell'exporter");
            } else if (elapsed > limit) {
                problems.add("tempo: " + elapsed + " ms oltre il massimo di " + limit + " ms (Non attendere non ha funzionato)");
            }
        }

        System.out.println("### " + variant + " " + sc.get("offerId").asText() + "/" + sc.get("name").asText() + " -> " + elapsed + " ms, "
                + (problems.isEmpty() ? "OK" : "DIFFERENZE") + " | risultato: " + body);
        if (!problems.isEmpty()) fail(String.join("\n", problems) + "\nrisposta: " + body);
    }
}
