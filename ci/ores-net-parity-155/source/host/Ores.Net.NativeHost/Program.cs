using Ores.Net.Runtime;

// Direct static call to generated CIL; Native AOT sees this reference at publish.
return RuntimeHost.Execute(Oreslang.Generated.OresProgram.Run);
