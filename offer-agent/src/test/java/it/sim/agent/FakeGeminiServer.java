package it.sim.agent;

import java.util.Map;

/**
 * Finto Gemini come processo autonomo, per provare a mano backend e interfaccia senza chiave reale.
 * <pre>
 * mvn -q test-compile exec:java "-Dexec.mainClass=it.sim.agent.FakeGeminiServer" "-Dexec.classpathScope=test"
 * </pre>
 * Stampa l'URL da usare come GEMINI_BASE_URL. Risponde alle specifiche di src/test/resources/specs per nome file.
 */
public final class FakeGeminiServer {

    private FakeGeminiServer() {
    }

    public static void main(String[] args) throws InterruptedException {
        Map<String, String> config = new FakeGemini().start();
        System.out.println("GEMINI_BASE_URL=" + config.get("agent.gemini.base-url"));
        Thread.currentThread().join();
    }
}
