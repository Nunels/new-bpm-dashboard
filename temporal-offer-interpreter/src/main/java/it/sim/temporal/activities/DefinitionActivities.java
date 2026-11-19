package it.sim.temporal.activities;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;

/**
 * Carica la definizione pubblicata (YAML). Il risultato viene registrato nella storia del workflow:
 * la pratica resta legata alla versione letta all'avvio anche se nel frattempo ne viene pubblicata un'altra.
 */
@ActivityInterface
public interface DefinitionActivities {

    /** Versione null o "latest" = la più recente pubblicata. */
    @ActivityMethod
    String load(String namespace, String name, String version);
}
