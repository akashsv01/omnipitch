# Deploy the OmniPitch API and UI to Azure Container Apps (consumption plan, scale to zero).
# Run one step at a time and review each before running it:
#   - consumption plan, scale to zero, 0.25 vCPU / 0.5 GiB, max 1 replica; logs destination none
#   - user-assigned managed identity with READ-ONLY Cosmos data access and the Web PubSub role needed to issue tokens
# The bridge is not deployed. No keys or connection strings anywhere.
#
# Usage (after `az login`, images pushed to GHCR and made public):
#   pwsh infra/containerapps.ps1 -Owner <registry-owner> -Tag <image-tag> -Subscription <id> -ResourceGroup <rg> -Location <region> `
#        -Cosmos <account> -WebPubSub <name> -EventhouseQueryUri <uri> -Step <register|env|identity|roles|api|web|all>
param(
    [Parameter(Mandatory)] [string]$Owner,              # container registry namespace for the images
    [Parameter(Mandatory)] [string]$Tag,
    [Parameter(Mandatory)] [string]$Subscription,
    [Parameter(Mandatory)] [string]$ResourceGroup,
    [Parameter(Mandatory)] [string]$Location,           # must be a region your subscription policy allows
    [Parameter(Mandatory)] [string]$Cosmos,             # Cosmos DB account name
    [Parameter(Mandatory)] [string]$WebPubSub,          # Web PubSub resource name
    [Parameter(Mandatory)] [string]$EventhouseQueryUri, # Fabric KQL database query URI
    [ValidateSet("register", "env", "identity", "roles", "api", "web", "all")] [string]$Step = "all",
    [string]$Environment = "omnipitch-env",
    [string]$Identity = "omnipitch-api-id",
    [string]$ApiApp = "omnipitch-api",
    [string]$WebApp = "omnipitch-web",
    [string]$DefaultRun = ""                            # optional Eventhouse run loaded on a fresh start
)
$ErrorActionPreference = "Stop"
$env:MSYS_NO_PATHCONV = "1"
function Run($name) { return ($Step -eq "all" -or $Step -eq $name) }
function Say($text) { Write-Host "-> $text" }
az account set --subscription $Subscription | Out-Null

if (Run "register") {
    foreach ($ns in "Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ManagedIdentity") {
        Say "register provider $ns (free)"; az provider register --namespace $ns --wait | Out-Null
    }
    az extension add --name containerapp --upgrade --only-show-errors | Out-Null
}

if (Run "env") {
    Say "Container Apps environment $Environment (consumption, logs off)"
    az containerapp env create -g $ResourceGroup -n $Environment -l $Location --logs-destination none --tags project=omnipitch -o none
}

if (Run "identity") {
    Say "user-assigned managed identity $Identity"
    az identity create -g $ResourceGroup -n $Identity -l $Location --tags project=omnipitch -o none
}
$principal = az identity show -g $ResourceGroup -n $Identity --query principalId -o tsv 2>$null
$clientId = az identity show -g $ResourceGroup -n $Identity --query clientId -o tsv 2>$null
$identityId = az identity show -g $ResourceGroup -n $Identity --query id -o tsv 2>$null

if (Run "roles") {
    Say "Cosmos: built-in Data READER on /dbs/omnipitch + metadata-only custom role at / (identity only)"
    az cosmosdb sql role assignment create -g $ResourceGroup -a $Cosmos --role-definition-id 00000000-0000-0000-0000-000000000001 `
        --principal-id $principal --scope "/dbs/omnipitch" -o none
    $meta = az cosmosdb sql role definition list -g $ResourceGroup -a $Cosmos --query "[?roleName=='OmniPitch Metadata Reader'].name | [0]" -o tsv
    az cosmosdb sql role assignment create -g $ResourceGroup -a $Cosmos --role-definition-id $meta --principal-id $principal --scope "/" -o none
    Say "Web PubSub: Service Owner on $WebPubSub only (needed to issue client tokens)"
    $wps = az webpubsub show -g $ResourceGroup -n $WebPubSub --query id -o tsv
    az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal --role "Web PubSub Service Owner" --scope $wps -o none
    Write-Host "   Fabric: add the identity '$Identity' (client id $clientId) as Viewer on workspace OmniPitch in the Fabric portal (Manage access)."
}

if (Run "api") {
    Say "API $ApiApp (internal ingress, scale 0-1, 0.25 vCPU)"
    az containerapp create -g $ResourceGroup -n $ApiApp --environment $Environment --image "ghcr.io/$Owner/omnipitch-api:$Tag" `
        --user-assigned $identityId --ingress internal --target-port 8000 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi `
        --env-vars OMNIPITCH_BACKEND_MODE=azure "AZURE_CLIENT_ID=$clientId" "EVENTHOUSE_QUERY_URI=$EventhouseQueryUri" `
            EVENTHOUSE_DATABASE=omnipitch EVENTHOUSE_TABLE=OmniPitchEvents OMNIPITCH_INSIGHTS=cosmos `
            "COSMOS_ENDPOINT=https://$Cosmos.documents.azure.com:443/" COSMOS_DATABASE=omnipitch `
            "WEBPUBSUB_ENDPOINT=https://$WebPubSub.webpubsub.azure.com" WEBPUBSUB_HUB=omnipitch "OMNIPITCH_DEFAULT_RUN=$DefaultRun" `
        --tags project=omnipitch -o none
}

if (Run "web") {
    # Express environments resolve neither short app names nor `.internal.` names: use <app>.<default domain> over https.
    $domain = az containerapp env show -g $ResourceGroup -n $Environment --query properties.defaultDomain -o tsv
    Say "UI $WebApp (external ingress, scale 0-1, proxies /api to https://$ApiApp.$domain)"
    az containerapp create -g $ResourceGroup -n $WebApp --environment $Environment --image "ghcr.io/$Owner/omnipitch-web:$Tag" `
        --ingress external --target-port 8080 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi `
        --env-vars "API_UPSTREAM=https://$ApiApp.$domain" --tags project=omnipitch -o none
    $fqdn = az containerapp show -g $ResourceGroup -n $WebApp --query properties.configuration.ingress.fqdn -o tsv
    Write-Host "UI: https://$fqdn  (the web image must be built with --build-arg PUBLIC_URL=https://$fqdn)"
}
