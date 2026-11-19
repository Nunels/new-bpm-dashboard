package it.sim.temporal.activities;

import io.temporal.failure.ApplicationFailure;

public final class DefinitionActivitiesImpl implements DefinitionActivities {

    public static final String NOT_FOUND = "DefinitionNotFound";

    private final DefinitionRepository repository;

    public DefinitionActivitiesImpl(DefinitionRepository repository) {
        this.repository = repository;
    }

    @Override
    public String load(String namespace, String name, String version) {
        return repository.find(namespace, name, version).orElseThrow(() -> ApplicationFailure.newNonRetryableFailure(
                "definizione non pubblicata: " + namespace + ":" + name + ":" + (version == null ? "latest" : version), NOT_FOUND));
    }
}
