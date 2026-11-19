package it.sim.agent;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;

/** Stato di una generazione, restituito al browser. I campi sono pubblici per la serializzazione JSON. */
public final class GenerationJob {

    public enum Status { RUNNING, SUCCESS, WARNING, ERROR }

    public static final class Attempt {
        public int n;
        /** GENERATION (primo tentativo) o REPAIR (correzione con gli errori del tentativo precedente). */
        public String kind;
        public List<String> errors = new ArrayList<>();
        public long millis;
    }

    public static final class DslFile {
        public String name;
        public String content;

        public DslFile() {
        }

        DslFile(String name, String content) {
            this.name = name;
            this.content = content;
        }
    }

    public final String id = UUID.randomUUID().toString();
    public final String fileName;
    public final String model;
    public final Instant startedAt = Instant.now();
    public volatile Instant finishedAt;
    public volatile Status status = Status.RUNNING;
    public volatile String progress = "In coda";
    public final List<Attempt> attempts = Collections.synchronizedList(new ArrayList<>());
    public volatile JsonNode offer;
    /** Risposta JSON del modello (offerta + assunzioni) dell'ultimo tentativo valido: sola lettura, per audit. */
    public volatile JsonNode modelOutput;
    public volatile List<DslFile> files = List.of();
    public volatile List<String> warnings = List.of();
    public volatile List<String> errors = List.of();
    public volatile Map<String, String> simulation = new LinkedHashMap<>();

    GenerationJob(String fileName, String model) {
        this.fileName = fileName;
        this.model = model;
    }

    void finish(Status s) {
        status = s;
        finishedAt = Instant.now();
        progress = switch (s) {
            case SUCCESS -> "Completata";
            case WARNING -> "Completata con avvisi";
            case ERROR -> "Non riuscita";
            default -> progress;
        };
    }
}
