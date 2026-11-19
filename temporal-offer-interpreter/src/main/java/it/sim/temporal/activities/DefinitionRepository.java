package it.sim.temporal.activities;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

/** Archivio delle definizioni pubblicate. Implementazioni: in memoria (test, embedding) e cartella su file system. */
public interface DefinitionRepository {

    Optional<String> find(String namespace, String name, String version);

    /** Voce dell'archivio: coordinate del documento e testo YAML. */
    record Entry(String namespace, String name, String version, String yaml) {
    }

    static Entry parse(String yaml) {
        try {
            JsonNode doc = new ObjectMapper(new YAMLFactory()).readTree(yaml).path("document");
            return new Entry(doc.path("namespace").asText(), doc.path("name").asText(), doc.path("version").asText(), yaml);
        } catch (IOException e) {
            throw new IllegalArgumentException("YAML non leggibile: " + e.getMessage(), e);
        }
    }

    /** Sceglie la versione richiesta oppure, con null/"latest", la più alta (confronto semantico major.minor.patch). */
    static Optional<String> select(List<Entry> entries, String namespace, String name, String version) {
        Stream<Entry> s = entries.stream().filter(e -> e.namespace().equals(namespace) && e.name().equals(name));
        if (version != null && !version.isBlank() && !"latest".equals(version)) {
            return s.filter(e -> e.version().equals(version)).map(Entry::yaml).findFirst();
        }
        return s.max(Comparator.comparing(Entry::version, DefinitionRepository::compareVersions)).map(Entry::yaml);
    }

    static int compareVersions(String a, String b) {
        String[] x = a.split("[.-]"), y = b.split("[.-]");
        for (int i = 0; i < Math.min(x.length, y.length); i++) {
            int c;
            try {
                c = Integer.compare(Integer.parseInt(x[i]), Integer.parseInt(y[i]));
            } catch (NumberFormatException e) {
                c = x[i].compareTo(y[i]);
            }
            if (c != 0) return c;
        }
        return Integer.compare(x.length, y.length);
    }

    /** In memoria: utile nei test o quando la pubblicazione avviene via API. */
    final class InMemory implements DefinitionRepository {
        private final List<Entry> entries = new CopyOnWriteArrayList<>();

        public InMemory publish(String yaml) {
            entries.add(parse(yaml));
            return this;
        }

        @Override
        public Optional<String> find(String namespace, String name, String version) {
            return select(entries, namespace, name, version);
        }
    }

    /** Cartella con file *.yaml / *.yml: riletta a ogni richiesta, quindi una nuova offerta pubblicata è subito disponibile. */
    final class Directory implements DefinitionRepository {
        private final Path dir;

        public Directory(Path dir) {
            this.dir = dir;
        }

        @Override
        public Optional<String> find(String namespace, String name, String version) {
            List<Entry> entries = new ArrayList<>();
            try (Stream<Path> files = Files.list(dir)) {
                for (Path f : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".yaml") || p.toString().endsWith(".yml"))::iterator) {
                    try {
                        entries.add(parse(Files.readString(f, StandardCharsets.UTF_8)));
                    } catch (IllegalArgumentException unreadable) {
                        // file non valido: lo ignoro, la validazione segnala i problemi delle definizioni lette
                    }
                }
            } catch (IOException e) {
                throw new UncheckedIOException("cartella definizioni non leggibile: " + dir, e);
            }
            return select(entries, namespace, name, version);
        }
    }
}
