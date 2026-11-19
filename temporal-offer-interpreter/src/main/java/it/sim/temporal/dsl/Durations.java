package it.sim.temporal.dsl;

import java.time.Duration;

import com.fasterxml.jackson.databind.JsonNode;

/** Durate della specifica: oggetto { days, hours, minutes, seconds, milliseconds } oppure stringa ISO 8601 (es. PT30S). */
public final class Durations {

    private Durations() {
    }

    public static boolean isValid(JsonNode n) {
        try {
            parse(n);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static Duration parse(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) throw new IllegalArgumentException("durata mancante");
        if (n.isTextual()) return Duration.parse(n.asText());
        if (!n.isObject()) throw new IllegalArgumentException("durata non valida: " + n);
        Duration d = Duration.ZERO;
        var it = n.fieldNames();
        while (it.hasNext()) {
            String k = it.next();
            long v = n.get(k).asLong();
            switch (k) {
                case "days" -> d = d.plusDays(v);
                case "hours" -> d = d.plusHours(v);
                case "minutes" -> d = d.plusMinutes(v);
                case "seconds" -> d = d.plusSeconds(v);
                case "milliseconds" -> d = d.plusMillis(v);
                default -> throw new IllegalArgumentException("unità di durata sconosciuta: " + k);
            }
        }
        return d;
    }
}
