# Recreate the Phase 2 Event Hubs resources (idempotent). Billable: a Standard namespace draws
# about $0.73/day of Azure credit while it exists. Delete with:  az group delete -n rg-omnipitch-dev --yes
#
# Usage (after `az login`, from any directory):
#   pwsh infra/eventhubs.ps1                         # or: powershell -File infra/eventhubs.ps1
#   pwsh infra/eventhubs.ps1 -Namespace omnipitch-ehns-<other>   # if the default name was taken
#
# Never prints keys. The Fabric teammate's listen-only key is fetched separately by the owner (see docs).
param(
    [string]$Subscription = "41939648-74f3-45b6-8b24-f986d316e0ef",   # Azure for Students
    [string]$ResourceGroup = "rg-omnipitch-dev",
    [string]$Location = "eastus",                                       # allowed: centralus, westus2, mexicocentral, eastus2, eastus
    [string]$Namespace = "omnipitch-ehns-qn36t",
    [string]$Hub = "match-events",
    [string]$ConsumerGroup = "fabric-eventstream",
    [string]$ListenRule = "eventstream-listen"
)
$ErrorActionPreference = "Stop"
function Step($text) { Write-Host "-> $text" }

az account set --subscription $Subscription | Out-Null
Step "provider Microsoft.EventHub"
az provider register --namespace Microsoft.EventHub --wait | Out-Null

Step "resource group $ResourceGroup ($Location)"
az group create -n $ResourceGroup -l $Location --tags project=omnipitch phase=2 -o none

$existing = az eventhubs namespace list -g $ResourceGroup --query "[?name=='$Namespace'] | length(@)" -o tsv
if ($existing -eq "0") {
    if ((az eventhubs namespace exists --name $Namespace --query nameAvailable -o tsv) -ne "true") {
        throw "Namespace name $Namespace is taken. Re-run with -Namespace omnipitch-ehns-<new suffix> and update EVENTHUB_FULLY_QUALIFIED_NAMESPACE."
    }
    Step "namespace $Namespace (Standard, 1 TU, auto-inflate off)"
    az eventhubs namespace create -g $ResourceGroup -n $Namespace -l $Location --sku Standard --capacity 1 `
        --enable-auto-inflate false --minimum-tls-version 1.2 --tags project=omnipitch -o none
}

Step "event hub $Hub (2 partitions, 24 h retention)"
if ((az eventhubs eventhub list -g $ResourceGroup --namespace-name $Namespace --query "[?name=='$Hub'] | length(@)" -o tsv) -eq "0") {
    az eventhubs eventhub create -g $ResourceGroup --namespace-name $Namespace -n $Hub --partition-count 2 `
        --retention-time-in-hours 24 --cleanup-policy Delete -o none
}

Step "consumer group $ConsumerGroup"
if ((az eventhubs eventhub consumer-group list -g $ResourceGroup --namespace-name $Namespace --eventhub-name $Hub --query "[?name=='$ConsumerGroup'] | length(@)" -o tsv) -eq "0") {
    az eventhubs eventhub consumer-group create -g $ResourceGroup --namespace-name $Namespace --eventhub-name $Hub -n $ConsumerGroup -o none
}

Step "listen-only SAS rule $ListenRule (for Fabric Eventstream)"
az eventhubs eventhub authorization-rule create -g $ResourceGroup --namespace-name $Namespace --eventhub-name $Hub `
    -n $ListenRule --rights Listen -o none

Step "Azure Event Hubs Data Sender for the signed-in user (hub scope)"
$hubId = az eventhubs eventhub show -g $ResourceGroup --namespace-name $Namespace -n $Hub --query id -o tsv
$me = az ad signed-in-user show --query id -o tsv
$has = az role assignment list --scope $hubId --assignee $me --query "[?roleDefinitionName=='Azure Event Hubs Data Sender'] | length(@)" -o tsv
if ($has -eq "0") {
    az role assignment create --assignee-object-id $me --assignee-principal-type User --role "Azure Event Hubs Data Sender" --scope $hubId -o none
    Write-Host "   (role propagation can take a few minutes before the first send succeeds)"
}

Write-Host ""
Write-Host "Done. Non-secret identifiers for services/api/.env:"
Write-Host "  EVENTHUB_FULLY_QUALIFIED_NAMESPACE=$Namespace.servicebus.windows.net"
Write-Host "  EVENTHUB_NAME=$Hub"
Write-Host "Fabric Eventstream: consumer group $ConsumerGroup, Shared Access Key name $ListenRule (owner shares the key privately)."
