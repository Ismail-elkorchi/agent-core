/** Capture committed accounting events for assertions without exposing production indexes. */
export function recordInferenceEvents(repository) {
  const events = [];
  const append = repository.append.bind(repository);
  repository.append = async (ownerId, event, tail) => {
    const committed = await append(ownerId, event, tail);
    if (committed) events.push({ ownerId, event });
    return committed;
  };
  return events;
}
