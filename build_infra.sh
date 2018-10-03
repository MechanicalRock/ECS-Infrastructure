aws cloudformation delete-stack --stack-name ecsDR --profile sandbox-devops-aus
aws cloudformation wait stack-delete-complete --stack-name ecsDR --profile sandbox-devops-aus
aws cloudformation create-stack --stack-name ecsDR --template-body file://infrastructure.yml --profile sandbox-devops-aus
