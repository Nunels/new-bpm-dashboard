package it.sim.temporal.activities;

import java.util.function.Consumer;

/** Implementazione con un publisher sostituibile: nel prototipo log o lista in memoria, in produzione un produttore Kafka. */
public final class EventActivitiesImpl implements EventActivities {

    private final Consumer<String> publisher;

    public EventActivitiesImpl(Consumer<String> publisher) {
        this.publisher = publisher;
    }

    /** Publisher di default: scrive l'evento sullo standard output. */
    public static EventActivitiesImpl logging() {
        return new EventActivitiesImpl(e -> System.out.println("[emit] " + e));
    }

    @Override
    public void emit(String cloudEventJson) {
        publisher.accept(cloudEventJson);
    }
}
