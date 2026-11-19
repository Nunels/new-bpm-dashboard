package it.sim.temporal.activities;

import java.util.LinkedHashMap;
import java.util.Map;

/** Dati scambiati tra workflow e activity HTTP (serializzati da Temporal in JSON). */
public final class HttpCall {

    private HttpCall() {
    }

    public static final class Request {
        public String method;
        public String uri;
        public Map<String, String> headers = new LinkedHashMap<>();
        public Map<String, String> query = new LinkedHashMap<>();
        /** Body JSON, oppure null. */
        public String bodyJson;

        public Request() {
        }
    }

    public static final class Response {
        public int status;
        public Map<String, String> headers = new LinkedHashMap<>();
        /** Body: JSON se la risposta è JSON, altrimenti una stringa JSON con il testo. */
        public String bodyJson;

        public Response() {
        }
    }
}
