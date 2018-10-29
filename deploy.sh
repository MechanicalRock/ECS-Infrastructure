set -e

STACKS=$(aws cloudformation list-stacks --profile $2)
if [[ $(echo ${STACKS}) == *route53Infrastructure* ]]; then
  aws cloudformation create-change-set --stack-name route53Infrastructure --change-set-name dns-change-set --change-set-type UPDATE --template-body file://dns.yml --parameters file://$1.json --profile $2
  if [[ $(aws cloudformation describe-change-set --stack-name route53Infrastructure --change-set-name dns-change-set --profile $2 | grep "Changes") != *[]* ]]; then
    aws cloudformation update-stack --stack-name route53Infrastructure --template-body file://dns.yml --parameters file://$1.json --profile $2
    aws cloudformation wait stack-update-complete --stack-name route53Infrastructure --profile $2
  fi
  aws cloudformation delete-change-set --stack-name route53Infrastructure --change-set-name dns-change-set --profile $2
else
  aws cloudformation create-stack --stack-name route53Infrastructure --template-body file://dns.yml --parameters file://$1.json --profile $2
  aws cloudformation wait stack-create-complete --stack-name route53Infrastructure --profile $2
fi

if [[ $(echo ${STACKS}) == *ecsInfrastructurePipeline* ]]; then
  aws cloudformation create-change-set --stack-name ecsInfrastructurePipeline --change-set-name pipeline-change-set --change-set-type UPDATE --template-body file://pipeline.yml --parameters file://$1.json --capabilities CAPABILITY_NAMED_IAM  --profile $2
  aws cloudformation wait change-set-create-complete --stack-name ecsInfrastructurePipeline --change-set-name pipeline-change-set --profile $2
  if [[ $(aws cloudformation describe-change-set --stack-name ecsInfrastructurePipeline --change-set-name pipeline-change-set --profile $2 | grep "Changes") != *[]* ]]; then
    aws cloudformation update-stack --stack-name ecsInfrastructurePipeline --template-body file://pipeline.yml --parameters file://$1.json --capabilities CAPABILITY_NAMED_IAM --profile $2
    aws cloudformation wait stack-update-complete --stack-name ecsInfrastructurePipeline --profile $2
  fi
  aws cloudformation delete-change-set --stack-name ecsInfrastructurePipeline --change-set-name pipeline-change-set --profile $2
else
  aws cloudformation create-stack --stack-name ecsInfrastructurePipeline --template-body file://pipeline.yml --parameters file://$1.json --capabilities CAPABILITY_NAMED_IAM --profile $2
  aws cloudformation wait stack-create-complete --stack-name ecsInfrastructurePipeline --profile $2
fi

echo "Pipeline deployment complete"
