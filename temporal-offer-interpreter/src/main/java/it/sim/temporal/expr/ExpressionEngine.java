package it.sim.temporal.expr;

import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Motore delle espressioni runtime di Serverless Workflow (${ ... }).
 * Isolato dietro un'interfaccia: oggi jq tramite jackson-jq, domani eventualmente un'altra implementazione.
 */
public interface ExpressionEngine {

    /** Compila l'espressione (senza ${ }). Lancia {@link ExpressionException} se non è valida. */
    void check(String expression);

    /**
     * Valuta l'espressione (senza ${ }) con "." = input e le variabili indicate ($context, $workflow, ...).
     * Un solo risultato viene restituito così com'è, più risultati come array, nessun risultato come null.
     */
    JsonNode evaluate(String expression, JsonNode input, Map<String, JsonNode> variables);

    final class ExpressionException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public ExpressionException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
