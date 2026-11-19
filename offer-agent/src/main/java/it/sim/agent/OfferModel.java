package it.sim.agent;

import com.fasterxml.jackson.databind.JsonNode;

/** Modello linguistico usato dall'agente: dato un prompt e uno schema JSON, restituisce il testo JSON generato. */
public interface OfferModel {

    /** Nome del modello, per audit e interfaccia. */
    String name();

    /** Vero se il modello è configurato (per esempio chiave API presente). */
    boolean configured();

    String generate(String prompt, JsonNode responseSchema) throws ModelException;

    final class ModelException extends Exception {
        private static final long serialVersionUID = 1L;
        private final boolean retryable;

        public ModelException(String message, boolean retryable) {
            super(message);
            this.retryable = retryable;
        }

        public boolean retryable() {
            return retryable;
        }
    }
}
